import pg from 'pg';
import { chatAnswerSchema } from '@videoq/trpc/chat';
import type { RagResult } from '../lib/rag';
import { databaseConnectionString, withClient, withDb, type Db } from '../db/pool';
import type { Bindings } from '../types/bindings';
import { checkedLtiSubject, type LtiDataSubject } from '../features/lti/identity';
import { lockLtiDataSession } from '../features/lti/data-lock';

export type PersistedConversationAnswer = { chatLogId: number | null; feedback: string | null };
export type PersistConversationLog = (result: RagResult, db: Db) => Promise<PersistedConversationAnswer>;

export const CONVERSATION_CHECKPOINT_SCHEMA = 'chat_memory';
export type ConversationScope = {
  ownerUserId: string;
  actorUserId: string | null;
  courseId: number | null;
  shareSlug: string | null;
  visitorSessionId?: string;
  ltiSubject?: LtiDataSubject;
};

export async function conversationThreadId(scope: ConversationScope, conversationId: string): Promise<string> {
  if (scope.shareSlug && !scope.visitorSessionId) throw new Error('Shared conversations require a visitor session');
  const subject = scope.ltiSubject ? checkedLtiSubject(scope.ltiSubject) : null;
  if (subject && (scope.actorUserId !== null || scope.shareSlug !== null || !Number.isSafeInteger(scope.courseId) || !scope.courseId || scope.courseId <= 0)) {
    throw new Error('Invalid LTI conversation scope');
  }
  const bytes = new TextEncoder().encode(JSON.stringify(subject ? [
    'lti-personal-conversation-v1', scope.ownerUserId, subject.subjectKey, scope.courseId, conversationId,
  ] : [
    scope.ownerUserId, scope.actorUserId, scope.courseId, scope.shareSlug, conversationId,
    ...(scope.shareSlug ? [scope.visitorSessionId] : []),
  ]));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

export class ConversationNotFoundError extends Error {
  constructor() { super('This conversation has expired or was deleted. Start a new conversation.'); }
}

export class ConversationBusyError extends Error {
  constructor() { super('This conversation is already generating an answer.'); }
}

/** Recheck current backend membership while holding the owning course stable.
 * Read/delete may use an empty scope; opening/committing model memory may not. */
export async function lockLtiConversationCourse(client: pg.Client, scope: ConversationScope, allowEmpty = false) {
  if (!scope.ltiSubject) return;
  const subject = checkedLtiSubject(scope.ltiSubject);
  await lockLtiDataSession(client,scope.ownerUserId,subject.sessionProof);
  const course = await client.query<{ user_id: string }>('SELECT user_id FROM video_courses WHERE id=$1 FOR SHARE', [scope.courseId]);
  if (course.rows[0]?.user_id !== scope.ownerUserId || !allowEmpty && !subject.resourceVideoIds.length) throw new ConversationNotFoundError();
  const members = await client.query(`SELECT m.video_id FROM video_course_members m JOIN videos v ON v.id=m.video_id
    WHERE m.course_id=$1 AND v.user_id=$2 AND m.video_id=ANY($3::bigint[]) FOR SHARE OF m,v`,
  [scope.courseId, scope.ownerUserId, subject.resourceVideoIds]);
  if (members.rowCount !== subject.resourceVideoIds.length) throw new ConversationNotFoundError();
}

export async function withConversationRead<T>(env: Bindings, scope: ConversationScope, operation: (client: pg.Client) => Promise<T>): Promise<T> {
  return withClient(env, async client => {
    if (!scope.ltiSubject) return operation(client);
    await client.query('BEGIN');
    try {
      await lockLtiConversationCourse(client, scope, true);
      const result = await operation(client);
      await client.query('COMMIT');
      return result;
    } catch (error) { await client.query('ROLLBACK'); throw error; }
  });
}

export function ltiConversationFilter(scope: ConversationScope, firstParameter: number) {
  if (!scope.ltiSubject) return { sql: '', values: [] };
  const subject = checkedLtiSubject(scope.ltiSubject);
  return { sql: ` AND EXISTS(SELECT 1 FROM lti_conversation_scopes s WHERE s.thread_id=chat_conversations.thread_id
    AND s.subject_key=$${firstParameter} AND s.resource_video_ids <@ $${firstParameter + 1}::jsonb)`,
  values: [subject.subjectKey, JSON.stringify(subject.resourceVideoIds)] };
}

/** Authorization must finish before opening a thread. Never accept a raw thread ID. */
export async function openConversation(env: Bindings, scope: ConversationScope, conversationId: string, requireExisting = false) {
  const { PostgresSaver } = await import("@langchain/langgraph-checkpoint-postgres");
  const threadId = await conversationThreadId(scope, conversationId);
  const leaseId = crypto.randomUUID();
  const scopeKey = await conversationThreadId(scope, "scope");
  const checkpointId = await withClient(env, async client => {
    await client.query('BEGIN');
    try {
      await lockLtiConversationCourse(client, scope);
      if (requireExisting && !(await client.query('SELECT 1 FROM chat_conversations WHERE thread_id = $1 AND expires_at > now() FOR UPDATE', [threadId])).rowCount) {
        throw new ConversationNotFoundError();
      }
      await client.query('DELETE FROM chat_conversations WHERE thread_id = $1 AND expires_at < now()', [threadId]);
      const { rowCount } = await client.query(`INSERT INTO chat_conversations
        (thread_id, owner_user_id, actor_user_id, course_id, lease_id, conversation_id, scope_key, leased_until, expires_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, now() + interval '20 minutes', now() + interval '30 days')
        ON CONFLICT (thread_id) DO UPDATE SET lease_id = EXCLUDED.lease_id,
          leased_until = EXCLUDED.leased_until, expires_at = EXCLUDED.expires_at,
          conversation_id = EXCLUDED.conversation_id, scope_key = EXCLUDED.scope_key
        WHERE chat_conversations.lease_id IS NULL OR chat_conversations.leased_until < now()
        RETURNING thread_id`, [threadId, scope.ownerUserId, scope.actorUserId, scope.courseId, leaseId, conversationId, scopeKey]);
      if (!rowCount) throw new ConversationBusyError();
      if (scope.ltiSubject) {
        const subject = checkedLtiSubject(scope.ltiSubject);
        const previous = await client.query<{ allowed: boolean }>(`SELECT subject_key=$2 AND resource_video_ids <@ $3::jsonb AS allowed
          FROM lti_conversation_scopes WHERE thread_id=$1`, [threadId, subject.subjectKey, JSON.stringify(subject.resourceVideoIds)]);
        if (previous.rows[0] && !previous.rows[0].allowed) throw new ConversationNotFoundError();
        await client.query(`INSERT INTO lti_conversation_scopes(thread_id,subject_key,resource_video_ids)
          VALUES($1,$2,$3::jsonb) ON CONFLICT(thread_id) DO NOTHING`, [threadId, subject.subjectKey, JSON.stringify(subject.resourceVideoIds)]);
      }
      const { rows } = await client.query<{ committed_checkpoint_id: string | null }>(
        'SELECT committed_checkpoint_id FROM chat_conversations WHERE thread_id = $1 AND lease_id = $2', [threadId, leaseId]);
      await client.query('COMMIT');
      return rows[0].committed_checkpoint_id;
    } catch (error) { await client.query('ROLLBACK'); throw error; }
  });
  // Workers cannot share pools between requests; Node may use its existing pool.
  const pool = env.DATABASE_POOL ?? new pg.Pool({ connectionString: databaseConnectionString(env), max: 2, connectionTimeoutMillis: 10_000 });
  return {
    threadId,
    checkpointId,
    saver: new PostgresSaver(pool, undefined, { schema: CONVERSATION_CHECKPOINT_SCHEMA }),
    async commit(result: RagResult, persistLog?: PersistConversationLog): Promise<PersistedConversationAnswer> {
      if (!result.checkpointId) throw new Error('Missing conversation checkpoint');
      return withDb(env, async (db, client) => {
        await client.query('BEGIN');
        try {
          await lockLtiConversationCourse(client, scope);
          const owned = await client.query(`SELECT thread_id FROM chat_conversations
            WHERE thread_id = $1 AND lease_id = $2 AND leased_until > now() FOR UPDATE`, [threadId, leaseId]);
          if (!owned.rowCount) throw new ConversationBusyError();
          const persisted = persistLog ? await persistLog(result, db) : { chatLogId: null, feedback: null };
          if (scope.ltiSubject) await client.query('UPDATE lti_conversation_scopes SET resource_video_ids=$2::jsonb WHERE thread_id=$1',
            [threadId, JSON.stringify(checkedLtiSubject(scope.ltiSubject).resourceVideoIds)]);
          await client.query(`INSERT INTO chat_conversation_turns (thread_id, checkpoint_id, question, response, chat_log_id)
            VALUES ($1, $2, $3, $4::jsonb, $5)`, [threadId, result.checkpointId, result.queryText,
            JSON.stringify(chatAnswerSchema.parse(result.answer)), persisted.chatLogId]);
          await client.query(`UPDATE chat_conversations SET committed_checkpoint_id = $3,
            title = CASE WHEN title = '' THEN $4 ELSE title END,
            updated_at = clock_timestamp(), expires_at = clock_timestamp() + interval '30 days'
            WHERE thread_id = $1 AND lease_id = $2`, [threadId, leaseId, result.checkpointId,
            result.queryText.trim().slice(0, 120)]);
          await client.query('COMMIT');
          return persisted;
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        }
      });
    },
    async close() {
      try {
        await withClient(env, client => client.query(`UPDATE chat_conversations SET lease_id = NULL, leased_until = NULL
          WHERE thread_id = $1 AND lease_id = $2`, [threadId, leaseId]));
      } finally {
        if (!env.DATABASE_POOL) await pool.end();
      }
    },
  };
}

/** Conversation ownership/expiry is application policy, independent of model compaction.
 * Ownership FKs cascade a whole thread, including course/account deletion. No
 * checkpoint generations, channel versions or parent pointers are rewritten.
 */
export async function pruneConversations(env: Bindings): Promise<number> {
  return withClient(env, async client => {
    await client.query('BEGIN');
    try {
      // Serialize expiration against a concurrent resume/commit before deleting logs.
      await client.query('SELECT thread_id FROM chat_conversations WHERE expires_at < now() FOR UPDATE');
      await client.query(`DELETE FROM chat_logs l USING lti_chat_log_subjects s WHERE l.id=s.chat_log_id AND (
        EXISTS(SELECT 1 FROM chat_conversation_turns t JOIN chat_conversations c ON c.thread_id=t.thread_id
          WHERE t.chat_log_id=l.id AND c.expires_at < now()) OR
        (l.created_at < now()-interval '30 days' AND NOT EXISTS(
          SELECT 1 FROM chat_conversation_turns t JOIN chat_conversations c ON c.thread_id=t.thread_id
          WHERE t.chat_log_id=l.id AND c.expires_at >= now())))`);
      const result = await client.query('DELETE FROM chat_conversations WHERE expires_at < now()');
      await client.query('COMMIT');
      return result.rowCount ?? 0;
    } catch (error) { await client.query('ROLLBACK'); throw error; }
  });
}
