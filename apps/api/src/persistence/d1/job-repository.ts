import { jobReclaimAllowed, jobClaimRefusal, jobLeaseMutationAllowed, type JobLeaseOperation } from '../../domain/operations/job-execution';
import { safeJobRepository } from '../job-failure';
import { safeJobFailureCode } from '../../domain/operations/job-failure';
import { and, eq, ne, or, isNull, sql } from "drizzle-orm";
import { createD1Connection } from "../../db/d1/connection";
import { jobExecutions } from "../../db/schema/sqlite";
import { JOB_LEASE_SECONDS, validateJobIdentity, type JobRepository } from "../contracts/job-repository";

export function createD1JobRepository(database: D1Database): JobRepository {
  const db = createD1Connection(database);
  const now = sql<string>`strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`;
  const leaseUntil = sql<string>`strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ${`+${JOB_LEASE_SECONDS} seconds`})`;
  const owns = (jobId: string, token: string, operation: JobLeaseOperation = 'complete') =>
    and(eq(jobExecutions.jobId, jobId), jobLeaseMutationAllowed(operation, {
      running: eq(jobExecutions.status, 'running'), tokenMatches: eq(jobExecutions.leaseToken, token), leaseActive: sql`${jobExecutions.leaseUntil} > ${now}`,
    }, { and: (...terms) => and(...terms)! }));
  return safeJobRepository({
    async claim(input) {
      validateJobIdentity(input);
      const leaseToken = crypto.randomUUID();
      const claimed = await db.insert(jobExecutions).values({
        ...input, status: "running", attempts: 1, leaseToken, leaseUntil,
      }).onConflictDoUpdate({
        target: jobExecutions.jobId,
        set: { status: "running", attempts: sql`${jobExecutions.attempts} + 1`, leaseToken, leaseUntil, lastError: "", updatedAt: now },
        setWhere: jobReclaimAllowed({
          sameIdentity: and(eq(jobExecutions.jobType, input.jobType), eq(jobExecutions.payloadSha256, input.payloadSha256))!,
          notCompleted: ne(jobExecutions.status, 'completed'), notRunning: ne(jobExecutions.status, 'running'),
          noLease: isNull(jobExecutions.leaseUntil), expired: sql`${jobExecutions.leaseUntil} <= ${now}`,
        }, { and: (...terms) => and(...terms)!, or: (...terms) => or(...terms)! }),
      }).returning({ id: jobExecutions.jobId });
      if (claimed.length) return { status: "claimed", leaseToken };
      const [existing] = await db.select().from(jobExecutions).where(eq(jobExecutions.jobId, input.jobId));
      if (!existing) throw new Error("Job execution disappeared");
      return { status: jobClaimRefusal(existing.jobType === input.jobType && existing.payloadSha256 === input.payloadSha256, existing.status) };
    },
    async complete(jobId, token) {
      const rows = await db.update(jobExecutions).set({ status: "completed", leaseToken: null, leaseUntil: null,
        completedAt: now, lastError: "", updatedAt: now }).where(owns(jobId, token)).returning({ id: jobExecutions.jobId });
      return rows.length > 0;
    },
    async fail(jobId, token, errorCode) {
      const rows = await db.update(jobExecutions).set({ status: "failed", leaseToken: null, leaseUntil: null,
        lastError: safeJobFailureCode(errorCode), updatedAt: now }).where(owns(jobId, token, 'fail')).returning({ id: jobExecutions.jobId });
      return rows.length > 0;
    },
    async heartbeat(jobId, token) {
      const rows = await db.update(jobExecutions).set({ leaseUntil, updatedAt: now })
        .where(owns(jobId, token, 'heartbeat')).returning({ id: jobExecutions.jobId });
      return rows.length > 0;
    },
  });
}
