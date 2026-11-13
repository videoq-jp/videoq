import pg from "pg";
import { describe } from "vitest";
import type { Bindings } from "../../src/types/bindings";
import { createPostgresJobRepository } from "../../src/persistence/postgres/job-repository";
import { jobRepositoryContract } from "./contracts/job-repository.contract";

const databaseUrl = process.env.PERSISTENCE_TEST_DATABASE_URL;
(databaseUrl ? describe : describe.skip)("PostgreSQL jobs", () => {
  jobRepositoryContract("postgres", async () => {
    const schema = `jobs_${crypto.randomUUID().replaceAll("-", "")}`;
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
      await pool.query(`CREATE TABLE job_executions (
        job_id text PRIMARY KEY, job_type text NOT NULL, payload_sha256 text NOT NULL,
        status text NOT NULL, attempts integer NOT NULL DEFAULT 0, lease_token text,
        lease_until timestamptz, completed_at timestamptz, last_error text NOT NULL DEFAULT '',
        created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
      )`);
      return {
        repository: createPostgresJobRepository({ DATABASE_POOL: pool } as Bindings),
        expireLease: async jobId => { await pool.query("UPDATE job_executions SET lease_until='2000-01-01' WHERE job_id=$1", [jobId]); },
        dispose,
      };
    } catch (error) { await dispose(); throw error; }
  });
});
