import type pg from 'pg';

// Matches the runtime schema; this migration has no application-source imports.
const CONVERSATION_CHECKPOINT_SCHEMA = 'chat_memory';

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
