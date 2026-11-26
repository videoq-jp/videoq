import { alias } from "drizzle-orm/pg-core";
import { sqlNumberArray } from "../../db/sql-array";
import {
  externalTaskFailure,
  storageCleanupRefundRequired,
  storageCleanupState,
  validateExternalTaskDeferral,
} from "../../domain/operations/external-task-policy";
import { storageCleanupDrizzleLogic } from "../external-task-policy-sql";
import { retentionBounds } from "../../domain/operations/retention-policy";
import {
  ExternalTaskLeaseLostError,
  type ExternalTaskLease,
  type ClaimedExternalTask,
  type PersistedExternalTask,
  type ExternalTaskHealth,
  type ExternalTaskKind,
  type ExternalTaskRepository,
} from "../contracts/external-task-repository";
import {
  and,
  eq,
  sql,
  or,
  isNull,
  isNotNull,
  inArray,
  notExists,
} from "drizzle-orm";
import { type Db, withDb } from "../../db/pool";
import { externalTasks, users, jobExecutions } from "../../db/schema";
import type { JobMessage } from "../../lib/job-message";
import type { Bindings } from "../../types/bindings";

/** attempts is a monotonic fencing token: an older claimant cannot update a new lease. */

/**
 * リース満了までの猶予。下の各クエリの `INTERVAL '5 minutes'` と同じ値であること。
 * TASK_SCHEDULER は、この猶予を過ぎた lock を回収するために起床時刻を決める。
 */
export { EXTERNAL_TASK_LEASE_MS } from "../contracts/external-task-repository";

function externalTaskLeaseCondition(lease: ExternalTaskLease) {
  return and(
    eq(externalTasks.id, lease.id),
    eq(externalTasks.attempts, lease.attempt),
    sql`${externalTasks.lockedAt} > clock_timestamp() - INTERVAL '5 minutes'`,
    sql`${externalTasks.completedAt} IS NULL`,
    sql`${externalTasks.deadAt} IS NULL`,
  );
}

/** Call inside the same transaction as the protected writes. */
export async function lockExternalTaskLease(
  db: Pick<Db, "select">,
  lease: ExternalTaskLease,
) {
  const rows = await db
    .select({ effectAppliedAt: externalTasks.effectAppliedAt })
    .from(externalTasks)
    .where(externalTaskLeaseCondition(lease))
    .for("update")
    .limit(1);
  if (rows.length === 0) throw new ExternalTaskLeaseLostError();
  return rows[0];
}

/** 呼び出し元のDB transactionにジョブ配送も含めるためのoutbox primitive。 */
export async function insertJobTask(
  db: Pick<Db, "insert" | "select">,
  params: { message: JobMessage; dedupeKey?: string },
): Promise<PersistedExternalTask> {
  const dedupeKey = params.dedupeKey ?? `job:${params.message.job_id}`;
  const inserted = await db
    .insert(externalTasks)
    .values({
      kind: "sqs_job",
      payload: { message: params.message },
      dedupeKey,
    })
    .onConflictDoNothing()
    .returning({ id: externalTasks.id });
  if (inserted.length > 0) {
    return { id: Number(inserted[0].id), created: true };
  }
  const existing = await db
    .select({ id: externalTasks.id })
    .from(externalTasks)
    .where(eq(externalTasks.dedupeKey, dedupeKey))
    .limit(1);
  if (existing.length === 0) throw new Error("External job task disappeared.");
  return { id: Number(existing[0].id), created: false };
}

export async function createJobTask(
  env: Bindings,
  params: { message: JobMessage; dedupeKey?: string },
): Promise<PersistedExternalTask> {
  return withDb(env, (db) => insertJobTask(db, params));
}

export async function claimExternalTasks(
  env: Bindings,
  params: {
    limit: number;
    taskId?: number;
    excludeTaskIds?: readonly number[];
  },
): Promise<ClaimedExternalTask[]> {
  return withDb(env, async (db) => {
    const candidates = db.$with("candidates").as(
      db
        .select({ id: externalTasks.id })
        .from(externalTasks)
        .where(
          and(
            isNull(externalTasks.completedAt),
            isNull(externalTasks.deadAt),
            sql`${externalTasks.availableAt}<=now()`,
            sql`NOT (${externalTasks.id}=ANY(${sqlNumberArray(params.excludeTaskIds ?? [])}))`,
            or(
              isNull(externalTasks.lockedAt),
              sql`${externalTasks.lockedAt}<now()-interval '5 minutes'`,
            ),
            params.taskId === undefined
              ? undefined
              : sql`${externalTasks.id}=${params.taskId}::bigint`,
          ),
        )
        .orderBy(externalTasks.availableAt, externalTasks.id)
        .for("update", { skipLocked: true })
        .limit(params.limit),
    );
    const rows = await db
      .with(candidates)
      .update(externalTasks)
      .set({
        lockedAt: sql`now()`,
        attempts: sql`${externalTasks.attempts}+1`,
        updatedAt: sql`now()`,
      })
      .from(candidates)
      .where(eq(externalTasks.id, candidates.id))
      .returning({
        id: externalTasks.id,
        attempts: externalTasks.attempts,
        kind: externalTasks.kind,
        payload: externalTasks.payload,
      });
    return rows.map((row) => ({
      id: Number(row.id),
      attempt: row.attempts,
      kind: row.kind as ExternalTaskKind,
      payload: row.payload,
    }));
  });
}

export async function completeExternalTask(
  env: Bindings,
  lease: ExternalTaskLease,
): Promise<void> {
  await withDb(env, async (db) => {
    const rows = await db
      .update(externalTasks)
      .set({
        completedAt: sql`now()`,
        lockedAt: null,
        lastError: "",
        updatedAt: sql`now()`,
      })
      .where(externalTaskLeaseCondition(lease))
      .returning({ id: externalTasks.id });
    if (rows.length === 0) throw new ExternalTaskLeaseLostError();
  });
}

/** R2削除後の容量返却とタスク完了を、同じDBトランザクションで一度だけ行う。 */
export async function completeStorageCleanupTask(
  env: Bindings,
  params: { lease: ExternalTaskLease; userId: string; bytes: number | null },
): Promise<void> {
  await withDb(env, async (db) =>
    db.transaction(async (tx) => {
      const task = await lockExternalTaskLease(tx, params.lease);

      if (
        task.effectAppliedAt === null &&
        storageCleanupRefundRequired(params.bytes)
      ) {
        const cleanup = storageCleanupState(
          {
            used: sql`${users.usedStorageBytes}`,
            refunded: sql`${params.bytes}`,
            limitGb: sql`${users.storageLimitGb}`,
            overQuota: sql`${users.isOverQuota}`,
          },
          storageCleanupDrizzleLogic,
        );
        await tx
          .update(users)
          .set({
            usedStorageBytes: cleanup.remaining,
            isOverQuota: cleanup.overQuota,
          })
          .where(eq(users.id, params.userId));
      }

      await tx
        .update(externalTasks)
        .set({
          effectAppliedAt: task.effectAppliedAt ?? sql`now()`,
          completedAt: sql`now()`,
          lockedAt: null,
          lastError: "",
          updatedAt: sql`now()`,
        })
        .where(eq(externalTasks.id, params.lease.id));
    }),
  );
}

export async function failExternalTask(
  env: Bindings,
  lease: ExternalTaskLease,
  error: string,
): Promise<{ dead: boolean; leaseLost: boolean }> {
  const failure = externalTaskFailure(lease.attempt);
  return withDb(env, async (db) => {
    const rows = await db
      .update(externalTasks)
      .set({
        lockedAt: null,
        lastError: error.slice(0, 2000),
        deadAt: failure.dead ? sql`now()` : null,
        availableAt: failure.dead
          ? sql`${externalTasks.availableAt}`
          : sql`now()+${failure.delaySeconds}*interval '1 second'`,
        updatedAt: sql`now()`,
      })
      .where(externalTaskLeaseCondition(lease))
      .returning({ dead: isNotNull(externalTasks.deadAt) });
    return { dead: rows[0]?.dead === true, leaseLost: rows.length === 0 };
  });
}

/** Workers Logs向けの小さなbacklog snapshot。監視系を業務処理へ混ぜない。 */
export async function getExternalTaskHealth(
  env: Bindings,
): Promise<ExternalTaskHealth> {
  return withDb(env, async (db) => {
    const pending = and(
      isNull(externalTasks.completedAt),
      isNull(externalTasks.deadAt),
    );
    const [row] = await db
      .select({
        pending: sql<string>`count(*) FILTER(WHERE ${pending})::text`,
        dead: sql<string>`count(*) FILTER(WHERE ${isNotNull(externalTasks.deadAt)})::text`,
        oldest: sql<
          string | null
        >`EXTRACT(EPOCH FROM now()-min(${externalTasks.createdAt}) FILTER(WHERE ${pending}))::text`,
      })
      .from(externalTasks);
    return {
      pending: Number(row?.pending ?? 0),
      dead: Number(row?.dead ?? 0),
      oldestPendingSeconds: row?.oldest == null ? null : Number(row.oldest),
    };
  });
}

/** SQS最大保持期間より長い30日を過ぎた完了台帳だけを、小分けで削除する。 */
export async function pruneDeliveryHistory(
  env: Bindings,
  retentionDays?: number,
  limit?: number,
): Promise<{ externalTasks: number; jobExecutions: number }> {
  const bounds = retentionBounds(retentionDays, limit);
  return withDb(env, async (db) => {
    const victims = db
      .select({ id: externalTasks.id })
      .from(externalTasks)
      .where(
        sql`${externalTasks.completedAt}<now()-(${bounds.retentionDays}*interval '1 day')`,
      )
      .orderBy(externalTasks.completedAt, externalTasks.id)
      .limit(bounds.limit);
    const external = await db
      .delete(externalTasks)
      .where(inArray(externalTasks.id, victims))
      .returning({ id: externalTasks.id });
    const candidate = alias(jobExecutions, "candidate");
    const jobs = db
      .select({ id: candidate.jobId })
      .from(candidate)
      .where(
        and(
          sql`${candidate.completedAt}<now()-(${bounds.retentionDays}*interval '1 day')`,
          notExists(
            db
              .select({ id: externalTasks.id })
              .from(externalTasks)
              .where(
                and(
                  eq(externalTasks.kind, "sqs_job"),
                  isNull(externalTasks.completedAt),
                  sql`${externalTasks.payload}->'message'->>'job_id'=${candidate.jobId}`,
                ),
              ),
          ),
        ),
      )
      .orderBy(candidate.completedAt, candidate.jobId)
      .limit(bounds.limit);
    const removedJobs = await db
      .delete(jobExecutions)
      .where(inArray(jobExecutions.jobId, jobs))
      .returning({ id: jobExecutions.jobId });
    return {
      externalTasks: external.length,
      jobExecutions: removedJobs.length,
    };
  });
}

/** 動画削除トランザクション内でcleanup taskを作るための小さな共通関数。 */
export async function insertStorageCleanupTask(
  db: Pick<Db, "insert" | "select">,
  params: {
    dedupeKey: string;
    userId: string;
    fileKey: string;
    bytes: number | null;
    multipartUploadId?: string;
  },
): Promise<number> {
  const rows = await db
    .insert(externalTasks)
    .values({
      kind: "storage_cleanup",
      payload: {
        user_id: params.userId,
        file_key: params.fileKey,
        bytes: params.bytes,
        ...(params.multipartUploadId
          ? { multipart_upload_id: params.multipartUploadId }
          : {}),
      },
      dedupeKey: params.dedupeKey,
    })
    .onConflictDoNothing()
    .returning({ id: externalTasks.id });
  if (rows.length > 0) return Number(rows[0].id);
  const existing = await db
    .select({ id: externalTasks.id })
    .from(externalTasks)
    .where(eq(externalTasks.dedupeKey, params.dedupeKey))
    .limit(1);
  if (existing.length === 0)
    throw new Error("Storage cleanup task disappeared.");
  return Number(existing[0].id);
}

export function createPostgresExternalTaskRepository(
  env: Bindings,
): ExternalTaskRepository {
  return {
    createJob: (params) => createJobTask(env, params),
    claim: (params) => claimExternalTasks(env, params),
    complete: (lease) => completeExternalTask(env, lease),
    async defer(lease, delayMs) {
      validateExternalTaskDeferral(delayMs);
      await withDb(env, async (db) => {
        const rows = await db
          .update(externalTasks)
          .set({
            availableAt: sql`clock_timestamp()+(${delayMs}*interval '1 millisecond')`,
            lockedAt: null,
            lastError: "",
            updatedAt: sql`clock_timestamp()`,
          })
          .where(externalTaskLeaseCondition(lease))
          .returning({ id: externalTasks.id });
        if (!rows.length) throw new ExternalTaskLeaseLostError();
      });
    },
    completeStorageCleanup: (params) => completeStorageCleanupTask(env, params),
    fail: (lease, error) => failExternalTask(env, lease, error),
    health: () => getExternalTaskHealth(env),
    pruneHistory: (days, limit) => pruneDeliveryHistory(env, days, limit),
  };
}
