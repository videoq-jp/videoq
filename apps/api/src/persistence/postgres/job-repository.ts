import { jobReclaimAllowed, jobClaimRefusal, jobLeaseMutationAllowed, type JobLeaseOperation } from '../../domain/operations/job-execution';
import { safeJobRepository } from '../job-failure';
import { safeJobFailureCode } from '../../domain/operations/job-failure';
import { and, eq, ne, or, isNull, sql } from "drizzle-orm";
import { withDb } from "../../db/pool";
import { jobExecutions as jobs } from "../../db/schema";
import type { Bindings } from "../../types/bindings";
import {
  JOB_LEASE_SECONDS,
  validateJobIdentity,
  type JobRepository,
} from "../contracts/job-repository";

const now = sql`now()`;
const leaseUntil = sql`now()+(${JOB_LEASE_SECONDS}*interval '1 second')`;
const owns = (jobId: string, token: string, operation: JobLeaseOperation = 'complete') =>
    and(eq(jobs.jobId, jobId), jobLeaseMutationAllowed(operation, {
      running: eq(jobs.status, 'running'), tokenMatches: eq(jobs.leaseToken, token), leaseActive: sql`${jobs.leaseUntil} > ${now}`,
    }, { and: (...terms) => and(...terms)! }));
export function createPostgresJobRepository(env: Bindings): JobRepository {
  return safeJobRepository({
    async claim(input) {
      validateJobIdentity(input);
      const leaseToken = crypto.randomUUID();
      return withDb(env, async (db) => {
        const claimed = await db
          .insert(jobs)
          .values({
            ...input,
            status: "running",
            attempts: 1,
            leaseToken,
            leaseUntil,
          })
          .onConflictDoUpdate({
            target: jobs.jobId,
            set: {
              status: "running",
              attempts: sql`${jobs.attempts}+1`,
              leaseToken,
              leaseUntil,
              lastError: "",
              updatedAt: now,
            },
            setWhere: jobReclaimAllowed({
          sameIdentity: and(eq(jobs.jobType, input.jobType), eq(jobs.payloadSha256, input.payloadSha256))!,
          notCompleted: ne(jobs.status, 'completed'), notRunning: ne(jobs.status, 'running'),
          noLease: isNull(jobs.leaseUntil), expired: sql`${jobs.leaseUntil} <= ${now}`,
        }, { and: (...terms) => and(...terms)!, or: (...terms) => or(...terms)! }),
          })
          .returning({ id: jobs.jobId });
        if (claimed.length) return { status: "claimed", leaseToken };
        const [existing] = await db
          .select({
            jobType: jobs.jobType,
            payloadSha256: jobs.payloadSha256,
            status: jobs.status,
          })
          .from(jobs)
          .where(eq(jobs.jobId, input.jobId));
        if (!existing) throw new Error("Job execution disappeared");
        return { status: jobClaimRefusal(existing.jobType === input.jobType && existing.payloadSha256 === input.payloadSha256, existing.status) };
      });
    },
    complete: (jobId, token) =>
      withDb(
        env,
        async (db) =>
          (
            await db
              .update(jobs)
              .set({
                status: "completed",
                leaseToken: null,
                leaseUntil: null,
                completedAt: now,
                lastError: "",
                updatedAt: now,
              })
              .where(owns(jobId, token))
              .returning({ id: jobs.jobId })
          ).length > 0,
      ),
    fail: (jobId, token, errorCode) =>
      withDb(
        env,
        async (db) =>
          (
            await db
              .update(jobs)
              .set({
                status: "failed",
                leaseToken: null,
                leaseUntil: null,
                lastError: safeJobFailureCode(errorCode),
                updatedAt: now,
              })
              .where(owns(jobId, token, 'fail'))
              .returning({ id: jobs.jobId })
          ).length > 0,
      ),
    heartbeat: (jobId, token) =>
      withDb(
        env,
        async (db) =>
          (
            await db
              .update(jobs)
              .set({ leaseUntil, updatedAt: now })
              .where(owns(jobId, token, 'heartbeat'))
              .returning({ id: jobs.jobId })
          ).length > 0,
      ),
  });
}
