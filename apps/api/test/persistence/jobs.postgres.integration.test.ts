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
        lastError: async jobId => (await pool.query('SELECT last_error FROM job_executions WHERE job_id=$1',[jobId])).rows[0]?.last_error,
        repository: createPostgresJobRepository({ DATABASE_POOL: pool } as Bindings),
        expireLease: async jobId => { await pool.query("UPDATE job_executions SET lease_until='2000-01-01' WHERE job_id=$1", [jobId]); },
        dispose,
      };
    } catch (error) { await dispose(); throw error; }
  });
});

import { createServer } from 'node:net';
import { expect,it } from 'vitest';
import { classifyJobFailure } from '../../src/domain/operations/job-failure';
it('classifies an actual refused PostgreSQL connection without retaining connection details',async()=>{
 const server=createServer();await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 const address=server.address();if(!address || typeof address==='string')throw new Error('fixture address');
 await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
 const repository=createPostgresJobRepository({DATABASE_URL:`postgresql://synthetic@127.0.0.1:${address.port}/postgres`} as Bindings);
 let failure:unknown;try{await repository.claim({jobId:'refused',jobType:'index_video_transcript',payloadSha256:'a'.repeat(64)});}catch(error){failure=error;}
 expect(classifyJobFailure(failure)).toEqual({error_code:'DATABASE_UNAVAILABLE',retryable:true});
 expect(failure).toBeInstanceOf(Error);expect((failure as Error).message).toBe('DATABASE_UNAVAILABLE');
});
