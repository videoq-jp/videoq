import pg from 'pg';
import { chatAnswerSchema } from '@videoq/trpc/chat';
import type { RagResult } from '../lib/rag';
import { databaseConnectionString, withClient, withDb, type Db } from '../db/pool';
import type { Bindings } from '../types/bindings';

export type PersistedConversationAnswer = { chatLogId: number | null; feedback: string | null };
export type PersistConversationLog = (result: RagResult, db: Db) => Promise<PersistedConversationAnswer>;

export const CONVERSATION_CHECKPOINT_SCHEMA = 'chat_memory';
export type ConversationScope = {
  ownerUserId: string;
  actorUserId: string | null;
  courseId: number | null;
  shareSlug: string | null;
};

export async function conversationThreadId(scope: ConversationScope, conversationId: string): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify([
    scope.ownerUserId, scope.actorUserId, scope.courseId, scope.shareSlug, conversationId,
  ]));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

/** Deployment only: let the official saver own its tables and migrations. */
export async function setupConversationCheckpoints(pool: pg.Pool): Promise<void> {
  const { PostgresSaver } = await import("@langchain/langgraph-checkpoint-postgres");
  const saver = new PostgresSaver(pool, undefined, { schema: CONVERSATION_CHECKPOINT_SCHEMA });
  await saver.setup();
  for (const table of ['checkpoints', 'checkpoint_blobs', 'checkpoint_writes']) {
    // Fixed application-owned identifiers, never derived from request input.
    await pool.query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = '${table}_conversation_fk'
        AND conrelid = 'chat_memory.${table}'::regclass) THEN
        ALTER TABLE chat_memory.${table} ADD CONSTRAINT ${table}_conversation_fk
          FOREIGN KEY (thread_id) REFERENCES public.chat_conversations(thread_id) ON DELETE CASCADE;
      END IF;
    END $$`);
  }
  // Production migration and API credentials use different roles. Local and
  // on-prem installations without these optional roles keep owner access.
  await pool.query(`DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'videoq_api_access') THEN
      GRANT USAGE ON SCHEMA chat_memory TO videoq_api_access;
      GRANT SELECT, INSERT, UPDATE, DELETE ON chat_memory.checkpoints,
        chat_memory.checkpoint_blobs, chat_memory.checkpoint_writes,
        public.chat_conversations, public.chat_conversation_turns TO videoq_api_access;
      GRANT USAGE, SELECT ON SEQUENCE public.chat_conversation_turns_id_seq TO videoq_api_access;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'videoq_backup_access') THEN
      GRANT USAGE ON SCHEMA chat_memory TO videoq_backup_access;
      GRANT SELECT ON ALL TABLES IN SCHEMA chat_memory TO videoq_backup_access;
    END IF;
  END $$`);
}

export class ConversationNotFoundError extends Error {
  constructor() { super('This conversation has expired or was deleted. Start a new conversation.'); }
}

export class ConversationBusyError extends Error {
  constructor() { super('This conversation is already generating an answer.'); }
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
          const owned = await client.query(`SELECT thread_id FROM chat_conversations
            WHERE thread_id = $1 AND lease_id = $2 AND leased_until > now() FOR UPDATE`, [threadId, leaseId]);
          if (!owned.rowCount) throw new ConversationBusyError();
          const persisted = persistLog ? await persistLog(result, db) : { chatLogId: null, feedback: null };
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
    const result = await client.query('DELETE FROM chat_conversations WHERE expires_at < now()');
    return result.rowCount ?? 0;
  });
}
