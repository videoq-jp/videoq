import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { bodyLimit } from 'hono/body-limit';
import type { AppEnv } from '../../types/bindings';
import { ApiError, toErrorBody } from '../../shared/errors';
import { listConversations, getConversation, deleteConversation } from '../chat/conversation-service';
import { ConversationNotFoundError, type ConversationScope } from '../../repositories/conversation-repository';
import type { CourseAccess } from './course-access';
import type { sessionRecord } from './protocol';
import { ltiSubjectKey } from './identity';

const conversation = { conversationId: z.uuid() };
const page = { ...conversation, beforeTurnId: z.string().regex(/^[1-9][0-9]{0,17}$/).optional(),
  limit: z.number().int().min(1).max(100).default(50) };
const input = z.discriminatedUnion('action', [
  z.object({ action: z.literal('list'), limit: z.number().int().min(1).max(50).default(20), offset: z.number().int().min(0).default(0) }).strict(),
  z.object({ action: z.literal('get'), ...page }).strict(),
  z.object({ action: z.literal('export'), ...page }).strict(),
  z.object({ action: z.literal('delete'), ...conversation }).strict(),
]);
type Authorization = { grant: z.infer<typeof sessionRecord>; current: CourseAccess; sessionHash: string;
  course: { userId: string; memberVideoIds: number[] } };
type Authorize = (c: Context<AppEnv>) => Promise<Authorization | { error: Response }>;
type FeedbackReference = (c: Context<AppEnv>, sessionHash: string, courseId: number, logId: number | null) => Promise<string | undefined>;

/** A course identifier or teacher role can never select another learner's history. */
export function mountLtiConversations(routes: Hono<AppEnv>, authorize: Authorize, feedbackReference: FeedbackReference) {
  routes.use('/conversations', bodyLimit({ maxSize: 8192, onError: c => c.json(toErrorBody('VALIDATION_ERROR', 'Conversation request is too large.'), 413) }));
  routes.post('/conversations', async c => {
    const access = await authorize(c);
    if ('error' in access) return access.error;
    if (!access.current.permissions.manageOwnHistory) return c.json(toErrorBody('FORBIDDEN', 'Personal history is unavailable.'), 403);
    const parsed = input.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json(toErrorBody('VALIDATION_ERROR', 'Invalid conversation request.'), 400);
    const { grant, course, current } = access;
    const scope: ConversationScope = { ownerUserId: course.userId, actorUserId: null, courseId: grant.courseId, shareSlug: null,
      ltiSubject: { subjectKey: await ltiSubjectKey(grant),
        resourceVideoIds: current.videos.map(video => video.videoId).filter(id => course.memberVideoIds.includes(id)) } };
    const data = parsed.data;
    try {
      if (data.action === 'list') return c.json(await listConversations(c.env, scope, data));
      if (data.action === 'delete') return c.json(await deleteConversation(c.env, scope, data.conversationId));
      const detail = await getConversation(c.env, scope, data);
      const turns = await Promise.all(detail.turns.map(async ({ chatLogId, feedbackToken: _feedbackToken, ...turn }) => ({ ...turn,
        ...(data.action === 'get' ? { feedbackId: await feedbackReference(c, access.sessionHash, grant.courseId, chatLogId) } : {}),
      })));
      return c.json({ ...detail, turns });
    } catch (error) {
      if (error instanceof ConversationNotFoundError) return c.json(toErrorBody('NOT_FOUND', 'Conversation not found.'), 404);
      if (error instanceof ApiError) return c.json(toErrorBody(error.code, error.expose ? error.message : 'Personal history is unavailable.'), error.status);
      console.error(JSON.stringify({ event: 'lti_conversation_failed' }));
      return c.json(toErrorBody('INTERNAL_ERROR', 'Personal history is unavailable.'), 500);
    }
  });
}
