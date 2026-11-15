import { describe } from "vitest";
import { createPostgresVideoMutationRepository } from "../../src/persistence/postgres/video-mutation-repository";
import { buildPendingUploadFileKey } from "../../src/lib/upload";
import type { Bindings } from "../../src/types/bindings";
import { isolatedPostgres } from "./isolated-postgres";
import { videoMutationContract } from "./contracts/video-mutation.contract";

const databaseUrl = process.env.PERSISTENCE_TEST_DATABASE_URL;
(databaseUrl ? describe : describe.skip)("PostgreSQL video mutations", () => {
  videoMutationContract("postgres", async () => {
    const { pool, dispose } = await isolatedPostgres(databaseUrl!);
    try {
      await pool.query(`CREATE TABLE users(id text PRIMARY KEY,used_upload_bytes bigint NOT NULL DEFAULT 5,used_storage_bytes bigint NOT NULL DEFAULT 5,upload_usage_period_start timestamptz);
        CREATE TABLE videos(id bigserial PRIMARY KEY,user_id text NOT NULL,file text NOT NULL,title text NOT NULL DEFAULT 'Lesson',description text NOT NULL DEFAULT '',
          transcript text NOT NULL DEFAULT 'Original',status text NOT NULL,uploaded_at timestamptz NOT NULL DEFAULT now(),error_message text NOT NULL DEFAULT '',
          source_type text NOT NULL DEFAULT 'uploaded',source_url text NOT NULL DEFAULT '',youtube_video_id text NOT NULL DEFAULT '',
          multipart_upload jsonb,upload_heartbeat_at timestamptz,upload_usage_period_start timestamptz);
        CREATE TABLE tags(id bigint,name text,color text);
        CREATE TABLE video_tags(id bigint PRIMARY KEY,video_id bigint REFERENCES videos(id) ON DELETE CASCADE,tag_id bigint);
        CREATE TABLE video_visual_runs(video_id bigint,run_id text,file_key text,status text,chunk_count int);
        CREATE TABLE video_visual_chunks(run_id text,frame_count int);
        CREATE TABLE scene_embeddings(langchain_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),video_id bigint,langchain_metadata json);
        CREATE TABLE mcp_idempotency_records(user_id text,resource_id bigint,action text);
        CREATE TABLE external_tasks(id bigserial PRIMARY KEY,kind text NOT NULL,payload jsonb NOT NULL,dedupe_key text NOT NULL UNIQUE,
          attempts integer NOT NULL DEFAULT 0,available_at timestamptz NOT NULL DEFAULT now(),locked_at timestamptz,completed_at timestamptz,dead_at timestamptz,
          effect_applied_at timestamptz,last_error text NOT NULL DEFAULT '',created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now());`);
      return {
        repository: createPostgresVideoMutationRepository({ DATABASE_POOL: pool } as Bindings),
        seed: async (status = "completed", staleUploadPeriod = false) => {
          await pool.query("INSERT INTO users(id,upload_usage_period_start) VALUES ('owner',date_trunc('month',now(),'UTC'))");
          const id = Number((await pool.query(`INSERT INTO videos(user_id,file,status,upload_usage_period_start)
            VALUES ('owner',$1,$2,CASE WHEN $3 THEN '2000-01-01'::timestamptz ELSE date_trunc('month',now(),'UTC') END) RETURNING id`,
          [buildPendingUploadFileKey("owner", 5, ".mp4"), status, staleUploadPeriod])).rows[0].id);
          await pool.query("INSERT INTO scene_embeddings(video_id) VALUES ($1)", [id]);
          return id;
        },
        rejectOutbox: async () => { await pool.query(`CREATE FUNCTION reject_outbox() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test outbox failure'; END $$;
          CREATE TRIGGER reject_outbox BEFORE INSERT ON external_tasks FOR EACH ROW EXECUTE FUNCTION reject_outbox()`); },
        snapshot: async () => {
          const row = (await pool.query(`SELECT (SELECT count(*) FROM videos)::int AS videos,(SELECT count(*) FROM scene_embeddings)::int AS scenes,
            (SELECT count(*) FROM external_tasks)::int AS tasks,used_upload_bytes,used_storage_bytes FROM users WHERE id='owner'`)).rows[0];
          return { videos: Number(row.videos), scenes: Number(row.scenes), externalTasks: Number(row.tasks), receipts: 0,
            uploadBytes: Number(row.used_upload_bytes), storageBytes: Number(row.used_storage_bytes) };
        },
        dispose,
      };
    } catch (error) { await dispose(); throw error; }
  });
});
