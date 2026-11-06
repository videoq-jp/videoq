import { chatAnswerSchema } from '@videoq/trpc/chat';
import { withClient } from '../../db/pool';
import { getCourseWithMembers } from '../../repositories/chat-repository';
import { conversationThreadId, ltiConversationFilter, lockLtiConversationCourse, withConversationRead, type ConversationScope } from '../../repositories/conversation-repository';
import { apiConflict, apiNotFound, ApiError } from '../../shared/errors';
import { createChatFeedbackToken } from '../../lib/chat-feedback-token';
import type { Bindings } from '../../types/bindings';

type AccessInput = { courseId?: number | null; shareSlug?: string };
export async function conversationScope(env: Bindings, userId: string | null, input: AccessInput, visitorSessionId?: string): Promise<ConversationScope> {
  if (!userId && !input.shareSlug) throw new ApiError(401, 'UNAUTHORIZED', 'Authentication is required.');
  if (input.shareSlug && !input.courseId) throw new ApiError(400, 'VALIDATION_ERROR', 'Course ID is required.');
  const course = input.courseId ? await getCourseWithMembers(env, {
    courseId: input.courseId, userId: input.shareSlug ? null : userId, shareToken: input.shareSlug,
  }) : null;
  if (input.courseId && !course) throw apiNotFound('Course not found.');
  return { ownerUserId: course?.userId ?? userId!, actorUserId: input.shareSlug ? null : userId,
    courseId: course?.id ?? null, shareSlug: input.shareSlug ?? null, ...(input.shareSlug ? { visitorSessionId } : {}) };
}

type ConversationRow = { id: string; title: string; createdAt: Date; updatedAt: Date; isGenerating: boolean };
const summary = (row: ConversationRow) => ({ ...row, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() });
const SUMMARY_COLUMNS = `conversation_id AS id, title, created_at AS "createdAt", updated_at AS "updatedAt",
  (lease_id IS NOT NULL AND leased_until > now()) AS "isGenerating"`;

export async function listConversations(env: Bindings, scope: ConversationScope,
  input: { conversationIds?: string[]; limit: number; offset: number }) {
  const scopeKey = await conversationThreadId(scope, 'scope');
  // Shared-link visitors have no account identity. UUIDs saved by this browser
  // select candidates only; the browser session independently authorizes access.
  const ids = scope.shareSlug ? input.conversationIds ?? [] : null;
  const filter = ltiConversationFilter(scope, 5);
  return withConversationRead(env, scope, async client => {
    const { rows } = await client.query<ConversationRow>(`SELECT ${SUMMARY_COLUMNS} FROM chat_conversations
      WHERE scope_key = $1 AND expires_at > now() AND committed_checkpoint_id IS NOT NULL
        AND ($2::uuid[] IS NULL OR conversation_id = ANY($2::uuid[]))${filter.sql}
      ORDER BY updated_at DESC, thread_id DESC LIMIT $3 OFFSET $4`, [scopeKey, ids, input.limit + 1, input.offset, ...filter.values]);
    return { items: rows.slice(0, input.limit).map(summary), hasMore: rows.length > input.limit };
  });
}

export async function getConversation(env: Bindings, scope: ConversationScope,
  input: { conversationId: string; beforeTurnId?: string; limit: number }) {
  const threadId = await conversationThreadId(scope, input.conversationId);
  const filter = ltiConversationFilter(scope, 2);
  return withConversationRead(env, scope, async client => {
    const { rows } = await client.query<ConversationRow>(`SELECT ${SUMMARY_COLUMNS} FROM chat_conversations
      WHERE thread_id = $1 AND expires_at > now()${filter.sql}${scope.ltiSubject ? ' FOR SHARE' : ''}`, [threadId, ...filter.values]);
    if (!rows[0]) throw apiNotFound('Conversation not found.');
    const turns = await client.query<{ id: string; question: string; response: unknown; createdAt: Date; chatLogId: string | null; feedback: 'good' | 'bad' | null }>(`
      SELECT t.id::text, t.question, t.response, t.created_at AS "createdAt", t.chat_log_id AS "chatLogId", l.feedback
      FROM chat_conversation_turns t LEFT JOIN chat_logs l ON l.id = t.chat_log_id
      WHERE t.thread_id = $1 AND ($2::bigint IS NULL OR t.id < $2::bigint)
      ORDER BY t.id DESC LIMIT $3`, [threadId, input.beforeTurnId ?? null, input.limit + 1]);
    const items = await Promise.all(turns.rows.slice(0, input.limit).reverse().map(async turn => {
      const chatLogId = turn.chatLogId === null ? null : Number(turn.chatLogId);
      const answer = chatAnswerSchema.parse(turn.response);
      const allowed = scope.ltiSubject?.resourceVideoIds;
      if (allowed && answer.sources.some(source => !allowed.includes(source.video_id))) throw apiNotFound('Conversation not found.');
      return { id: turn.id, question: turn.question, answer,
        ...(scope.ltiSubject ? { createdAt: turn.createdAt.toISOString() } : {}),
        chatLogId, feedback: turn.feedback,
        ...(scope.shareSlug && chatLogId !== null
          ? { feedbackToken: await createChatFeedbackToken(env, chatLogId, scope.shareSlug) } : {}),
      };
    }));
    return { ...summary(rows[0]), turns: items, hasMore: turns.rows.length > input.limit };
  });
}

export async function deleteConversation(env: Bindings, scope: ConversationScope, id: string) {
  const threadId = await conversationThreadId(scope, id);
  return withClient(env, async client => {
    await client.query('BEGIN');
    try {
      await lockLtiConversationCourse(client, scope);
      const row = await client.query<{ busy: boolean }>(`SELECT (lease_id IS NOT NULL AND leased_until > now()) AS busy
        FROM chat_conversations WHERE thread_id = $1 FOR UPDATE`, [threadId]);
      if (row.rows[0]?.busy) throw apiConflict('Wait for the current answer to finish before deleting this conversation.', 'CONVERSATION_BUSY');
      await client.query(`DELETE FROM chat_logs WHERE id IN (
        SELECT chat_log_id FROM chat_conversation_turns WHERE thread_id = $1
      )`, [threadId]);
      await client.query('DELETE FROM chat_conversations WHERE thread_id = $1', [threadId]);
      await client.query('COMMIT');
      return { success: true as const };
    } catch (error) { await client.query('ROLLBACK'); throw error; }
  });
}
