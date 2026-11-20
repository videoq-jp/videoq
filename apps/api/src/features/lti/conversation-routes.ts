import { canUseLearningConversations, learningConversationScope, learningConversationTurns, type LearningOperationAccess } from './operation-policy';
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { bodyLimit } from 'hono/body-limit';
import type { AppEnv } from '../../types/bindings';
import { asApiError, toErrorBody } from '../../shared/errors';
import { listConversations, getConversation, deleteConversation } from '../../integrations/conversations';
import { ConversationNotFoundError } from '../../repositories/conversation-repository';
import { ltiSubjectKey } from './identity';
import { ltiSessionProof } from './data-lock';

const conversation = { conversationId: z.uuid() };
const page = { ...conversation, beforeTurnId: z.string().regex(/^[1-9][0-9]{0,17}$/).optional(),
  limit: z.number().int().min(1).max(100).default(50) };
const input = z.discriminatedUnion('action', [
  z.object({ action: z.literal('list'), limit: z.number().int().min(1).max(50).default(20), offset: z.number().int().min(0).default(0) }).strict(),
  z.object({ action: z.literal('get'), ...page }).strict(),
  z.object({ action: z.literal('export'), ...page }).strict(),
  z.object({ action: z.literal('delete'), ...conversation }).strict(),
]);
type Authorization = LearningOperationAccess;
type Authorize = (c: Context<AppEnv>) => Promise<Authorization | { error: Response }>;
type FeedbackReference = (c: Context<AppEnv>, sessionHash: string, courseId: number, logId: number | null) => Promise<string | undefined>;

/** A course identifier or teacher role can never select another learner's history. */
export function mountLtiConversations(routes: Hono<AppEnv>, authorize: Authorize, feedbackReference: FeedbackReference) {
  routes.use('/conversations', bodyLimit({ maxSize: 8192, onError: c => c.json(toErrorBody('VALIDATION_ERROR', 'Conversation request is too large.'), 413) }));
  routes.post('/conversations', async c => {
    const access = await authorize(c);
    if ('error' in access) return access.error;
    if (!canUseLearningConversations(access)) return c.json(toErrorBody('FORBIDDEN', 'Personal history is unavailable.'), 403);
    const parsed = input.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json(toErrorBody('VALIDATION_ERROR', 'Invalid conversation request.'), 400);
    const { grant } = access;
    const scope = learningConversationScope(access, await ltiSubjectKey(grant), ltiSessionProof(grant, access.sessionHash));
    const data = parsed.data;
    try {
      if (data.action === 'list') return c.json(await listConversations(c.env, scope, data));
      if (data.action === 'delete') return c.json(await deleteConversation(c.env, scope, data.conversationId));
      const detail = await getConversation(c.env, scope, data);
      const turns = await learningConversationTurns(detail.turns, data.action,
        logId => feedbackReference(c, access.sessionHash, grant.courseId, logId));
      return c.json({ ...detail, turns });
    } catch (error) {
      if (error instanceof ConversationNotFoundError) return c.json(toErrorBody('NOT_FOUND', 'Conversation not found.'), 404);
      const failure = asApiError(error);
      if (failure) return c.json(toErrorBody(failure.code, failure.expose ? failure.message : 'Personal history is unavailable.'), failure.status);
      console.error(JSON.stringify({ event: 'lti_conversation_failed' }));
      return c.json(toErrorBody('INTERNAL_ERROR', 'Personal history is unavailable.'), 500);
    }
  });
}
