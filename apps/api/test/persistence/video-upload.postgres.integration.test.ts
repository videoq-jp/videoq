import pg from "pg";
import { describe } from "vitest";
import { createPostgresVideoUploadRepository } from "../../src/persistence/postgres/video-upload-repository";
import type { Bindings } from "../../src/types/bindings";
import { videoUploadContract } from "./contracts/video-upload.contract";

const databaseUrl = process.env.PERSISTENCE_TEST_DATABASE_URL;
(databaseUrl ? describe : describe.skip)("PostgreSQL video registration", () => {
  videoUploadContract("postgres", async () => {
    const schema = `uploads_${crypto.randomUUID().replaceAll("-", "")}`;
    const admin = new pg.Client({ connectionString: databaseUrl });
    await admin.connect();
    const pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 4 });
    const dispose = async () => {
      try { await pool.end(); }
      finally {
        try { await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); }
        finally { await admin.end(); }
      }
    };
    try {
      await admin.query(`CREATE SCHEMA "${schema}"`);
      await pool.query(`CREATE TABLE users (
        id text PRIMARY KEY, is_over_quota boolean NOT NULL DEFAULT false,
        used_storage_bytes bigint NOT NULL DEFAULT 0, used_upload_bytes bigint NOT NULL DEFAULT 0,
        storage_limit_gb double precision, monthly_upload_limit_gb double precision, upload_usage_period_start timestamptz
      );
      CREATE TABLE videos (
        managed_by_lms boolean NOT NULL DEFAULT false, id bigserial PRIMARY KEY, user_id text NOT NULL REFERENCES users(id), file text NOT NULL,
        title text NOT NULL CHECK (title <> 'reject'), description text NOT NULL, status text NOT NULL,
        source_type text NOT NULL, source_url text NOT NULL, youtube_video_id text NOT NULL,
        transcript text NOT NULL, error_message text NOT NULL, uploaded_at timestamptz NOT NULL,
        upload_usage_period_start timestamptz, transcription_language text, multipart_upload jsonb, upload_heartbeat_at timestamptz, processing_seconds integer NOT NULL DEFAULT 0
      );
      CREATE TABLE mcp_idempotency_records (
        user_id text NOT NULL, action text NOT NULL, key text NOT NULL, request_hash text NOT NULL,
        resource_id bigint NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(user_id,action,key)
      );
      CREATE TABLE external_tasks (
        id bigserial PRIMARY KEY, kind text NOT NULL, payload jsonb NOT NULL, dedupe_key text NOT NULL UNIQUE,
        attempts integer NOT NULL DEFAULT 0, created_at timestamptz NOT NULL DEFAULT now(),
        available_at timestamptz NOT NULL DEFAULT now(),locked_at timestamptz,completed_at timestamptz,dead_at timestamptz,
        effect_applied_at timestamptz,last_error text NOT NULL DEFAULT '',updated_at timestamptz NOT NULL DEFAULT now()
      );`);
      return {
        repository: createPostgresVideoUploadRepository({ DATABASE_POOL: pool } as Bindings),
        seedOwner: async (options = {}) => {
          await pool.query(`INSERT INTO users (id,storage_limit_gb,monthly_upload_limit_gb,used_upload_bytes,upload_usage_period_start)
            VALUES ('owner',$1,$2,$3,$4)`, [
            options.storageLimit === null ? null : (options.storageLimit ?? 100) / 1024 ** 3,
            options.monthlyLimit === null ? null : (options.monthlyLimit ?? 100) / 1024 ** 3,
            options.staleMonth ? 1000 : 0, options.staleMonth ? "2000-01-01T00:00:00.000Z" : new Date().toISOString(),
          ]);
        },
        blockOwner: async () => { await pool.query("UPDATE users SET is_over_quota=true WHERE id='owner'"); },
        failOutbox: async () => { await pool.query(`CREATE FUNCTION reject_outbox() RETURNS trigger LANGUAGE plpgsql AS
          $$ BEGIN RAISE EXCEPTION 'test outbox rejection'; END $$;
          CREATE TRIGGER reject_outbox BEFORE INSERT ON external_tasks FOR EACH ROW EXECUTE FUNCTION reject_outbox()`); },
        snapshot: async () => {
          const user = (await pool.query("SELECT used_storage_bytes,used_upload_bytes FROM users WHERE id='owner'")).rows[0];
          const videos = (await pool.query("SELECT id::int,status FROM videos ORDER BY id")).rows;
          const tasks = (await pool.query("SELECT id::int,payload FROM external_tasks ORDER BY id")).rows;
          return { storageBytes: Number(user?.used_storage_bytes ?? 0), uploadBytes: Number(user?.used_upload_bytes ?? 0), videos,
            tasks: tasks.map(task => ({ id: task.id as number, videoId: task.payload.message.payload.video_id as number, jobId: task.payload.message.job_id as string })),
            receiptCount: Number((await pool.query("SELECT count(*) AS count FROM mcp_idempotency_records")).rows[0].count) };
        },
        dispose,
      };
    } catch (error) { await dispose(); throw error; }
  });
});
