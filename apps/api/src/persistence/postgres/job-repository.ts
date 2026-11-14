import { withClient } from "../../db/pool";
import type { Bindings } from "../../types/bindings";
import { JOB_LEASE_SECONDS, validateJobIdentity, type JobRepository } from "../contracts/job-repository";

export function createPostgresJobRepository(env: Bindings): JobRepository {
  return {
    async claim(input) {
      validateJobIdentity(input);
      const leaseToken = crypto.randomUUID();
      return withClient(env, async client => {
        const claimed = await client.query(`INSERT INTO job_executions
          (job_id,job_type,payload_sha256,status,attempts,lease_token,lease_until)
          VALUES ($1,$2,$3,'running',1,$4,now()+($5*interval '1 second'))
          ON CONFLICT (job_id) DO UPDATE SET status='running',attempts=job_executions.attempts+1,
            lease_token=EXCLUDED.lease_token,lease_until=EXCLUDED.lease_until,last_error='',updated_at=now()
          WHERE job_executions.job_type=EXCLUDED.job_type AND job_executions.payload_sha256=EXCLUDED.payload_sha256
            AND job_executions.status<>'completed' AND
            (job_executions.status<>'running' OR job_executions.lease_until IS NULL OR job_executions.lease_until<=now())
          RETURNING job_id`, [input.jobId, input.jobType, input.payloadSha256, leaseToken, JOB_LEASE_SECONDS]);
        if (claimed.rowCount) return { status: "claimed", leaseToken };
        const existing = (await client.query<{ job_type: string; payload_sha256: string; status: string }>(
          "SELECT job_type,payload_sha256,status FROM job_executions WHERE job_id=$1", [input.jobId])).rows[0];
        if (!existing) throw new Error("Job execution disappeared");
        if (existing.job_type !== input.jobType || existing.payload_sha256 !== input.payloadSha256) return { status: "conflict" };
        return { status: existing.status === "completed" ? "completed" : "busy" };
      });
    },
    complete: (jobId, token) => withClient(env, async client => Boolean((await client.query(`UPDATE job_executions
      SET status='completed',lease_token=NULL,lease_until=NULL,completed_at=now(),last_error='',updated_at=now()
      WHERE job_id=$1 AND status='running' AND lease_token=$2 RETURNING job_id`, [jobId, token])).rowCount)),
    fail: (jobId, token, errorCode) => withClient(env, async client => Boolean((await client.query(`UPDATE job_executions
      SET status='failed',lease_token=NULL,lease_until=NULL,last_error=$3,updated_at=now()
      WHERE job_id=$1 AND status='running' AND lease_token=$2 RETURNING job_id`, [jobId, token, errorCode.slice(0, 2000)])).rowCount)),
    heartbeat: (jobId, token) => withClient(env, async client => Boolean((await client.query(`UPDATE job_executions
      SET lease_until=now()+($3*interval '1 second'),updated_at=now()
      WHERE job_id=$1 AND status='running' AND lease_token=$2 AND lease_until>now() RETURNING job_id`, [jobId, token, JOB_LEASE_SECONDS])).rowCount)),
  };
}
