import { safeJobFailureCode } from '../../application/job-failure';
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
const owns = (jobId: string, token: string) =>
  and(
    eq(jobs.jobId, jobId),
    eq(jobs.status, "running"),
    eq(jobs.leaseToken, token),
  );
export function createPostgresJobRepository(env: Bindings): JobRepository {
  return {
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
            setWhere: and(
              eq(jobs.jobType, input.jobType),
              eq(jobs.payloadSha256, input.payloadSha256),
              ne(jobs.status, "completed"),
              or(
                ne(jobs.status, "running"),
                isNull(jobs.leaseUntil),
                sql`${jobs.leaseUntil}<=${now}`,
              ),
            ),
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
        if (
          existing.jobType !== input.jobType ||
          existing.payloadSha256 !== input.payloadSha256
        )
          return { status: "conflict" };
        return {
          status: existing.status === "completed" ? "completed" : "busy",
        };
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
              .where(owns(jobId, token))
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
              .where(and(owns(jobId, token), sql`${jobs.leaseUntil}>${now}`))
              .returning({ id: jobs.jobId })
          ).length > 0,
      ),
  };
}
