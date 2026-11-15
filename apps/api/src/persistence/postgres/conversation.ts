import {apiConflict,apiNotFound} from '../../shared/errors';
import type {ConversationRepository} from '../contracts/conversation';
import pg from 'pg';
import {chatAnswerSchema} from '@videoq/trpc/chat';
import type {RagResult} from '../../lib/rag';
import {databaseConnectionString,withClient,withDb} from '../../db/pool';
import type {Bindings} from '../../types/bindings';
import {checkedLtiSubject} from '../../features/lti/identity';
import {lockLtiDataSession} from './lti-session-lock';
import {conversationThreadId} from '../../shared/conversation-scope';
import {CONVERSATION_CHECKPOINT_SCHEMA,ConversationNotFoundError,ConversationBusyError,type ConversationScope,type PersistConversationLog,type PersistedConversationAnswer} from '../contracts/conversation';
import {createChatLogWithDb} from './chat-repository';

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
          const logInput=persistLog?await persistLog(result):null;
          const log=logInput?await createChatLogWithDb(db,logInput):null;
          const persisted=log?{chatLogId:log.id,feedback:log.feedback}:{chatLogId:null,feedback:null};
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

type ConversationRow = { id: string; title: string; createdAt: Date; updatedAt: Date; isGenerating: boolean };
const summary = (row: ConversationRow) => ({ ...row, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() });
const SUMMARY_COLUMNS = `conversation_id AS id, title, created_at AS "createdAt", updated_at AS "updatedAt",
  (lease_id IS NOT NULL AND leased_until > now()) AS "isGenerating"`;

async function listConversations(env: Bindings, scope: ConversationScope,
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

async function getConversation(env: Bindings, scope: ConversationScope,
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
    const items = turns.rows.slice(0, input.limit).reverse().map(turn => {
      const chatLogId = turn.chatLogId === null ? null : Number(turn.chatLogId);
      const answer = chatAnswerSchema.parse(turn.response);
      return { id: turn.id, question: turn.question, answer,createdAt:turn.createdAt.toISOString(),chatLogId,feedback:turn.feedback };
    });
    return { ...summary(rows[0]), turns: items, hasMore: turns.rows.length > input.limit };
  });
}

async function deleteConversation(env: Bindings, scope: ConversationScope, id: string) {
  const threadId = await conversationThreadId(scope, id);
  return withClient(env, async client => {
    await client.query('BEGIN');
    try {
      await lockLtiConversationCourse(client, scope, true);
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

export function createPostgresConversationRepository(env:Bindings):ConversationRepository {
  return {list:(scope,input)=>listConversations(env,scope,input),detail:(scope,input)=>getConversation(env,scope,input),delete:(scope,id)=>deleteConversation(env,scope,id)};
}
