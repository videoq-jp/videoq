import { describe } from "vitest";
import { createPostgresExternalTaskRepository } from "../../src/persistence/postgres/external-task-repository";
import type { Bindings } from "../../src/types/bindings";
import { externalTaskContract } from "./contracts/external-task.contract";
import { isolatedPostgres } from "./isolated-postgres";

const databaseUrl = process.env.PERSISTENCE_TEST_DATABASE_URL;
(databaseUrl ? describe : describe.skip)("PostgreSQL outbox", () => {
  externalTaskContract("postgres", async () => {
    const { pool, dispose } = await isolatedPostgres(databaseUrl!);
    try {
      await pool.query(`CREATE TABLE users (
        id text PRIMARY KEY,used_storage_bytes bigint NOT NULL,storage_limit_gb double precision,is_over_quota boolean NOT NULL
      );
      CREATE TABLE external_tasks (
        id bigserial PRIMARY KEY,kind text NOT NULL,payload jsonb NOT NULL,dedupe_key text NOT NULL UNIQUE,
        attempts integer NOT NULL DEFAULT 0,available_at timestamptz NOT NULL DEFAULT now(),locked_at timestamptz,
        completed_at timestamptz,dead_at timestamptz,effect_applied_at timestamptz,last_error text NOT NULL DEFAULT '',
        created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE job_executions(job_id text PRIMARY KEY,completed_at timestamptz);`);
      return {
        repository: createPostgresExternalTaskRepository({ DATABASE_POOL: pool } as Bindings),
        expireAndReady: async id => { await pool.query("UPDATE external_tasks SET locked_at='2000-01-01',available_at='2000-01-01' WHERE id=$1", [id]); },
        setAttempts: async (id, attempts) => { await pool.query("UPDATE external_tasks SET attempts=$1 WHERE id=$2", [attempts, id]); },
        createCleanup: async (effectApplied = false) => {
          await pool.query("INSERT INTO users VALUES ('owner',10,$1,true)", [5 / 1024 ** 3]);
          return Number((await pool.query(`INSERT INTO external_tasks(kind,payload,dedupe_key,effect_applied_at)
            VALUES ('storage_cleanup','{}','storage:owner',$1) RETURNING id`, [effectApplied ? "2000-01-01" : null])).rows[0].id);
        },
        rejectCompletion: async () => { await pool.query(`CREATE FUNCTION reject_complete() RETURNS trigger LANGUAGE plpgsql AS
          $$ BEGIN IF NEW.completed_at IS NOT NULL THEN RAISE EXCEPTION 'test completion rejection'; END IF; RETURN NEW; END $$;
          CREATE TRIGGER reject_complete BEFORE UPDATE ON external_tasks FOR EACH ROW EXECUTE FUNCTION reject_complete()`); },
        seedHistory: async () => {
          await pool.query(`INSERT INTO job_executions VALUES ('free','2000-01-01'),('protected','2000-01-01');
            INSERT INTO external_tasks(kind,payload,dedupe_key,completed_at) VALUES
            ('sqs_job','{"message":{"job_id":"free"}}','free','2000-01-01'),
            ('sqs_job','{"message":{"job_id":"protected"}}','protected',NULL)`);
        },
        snapshot: async () => {
          const user = (await pool.query("SELECT used_storage_bytes,is_over_quota FROM users WHERE id='owner'")).rows[0];
          return { storageBytes: Number(user?.used_storage_bytes ?? 0), overQuota: Boolean(user?.is_over_quota), receipts: 0,
            completed: Number((await pool.query("SELECT count(*) AS count FROM external_tasks WHERE completed_at IS NOT NULL")).rows[0].count),
            protectedJob: Boolean((await pool.query("SELECT job_id FROM job_executions WHERE job_id='protected'")).rows[0]),
          };
        },
        dispose,
      };
    } catch (error) { await dispose(); throw error; }
  });
});
