import { ExternalTaskLeaseLostError, type ExternalTaskLease, type ClaimedExternalTask, type PersistedExternalTask, type ExternalTaskHealth, type ExternalTaskKind, type ExternalTaskRepository } from "../contracts/external-task-repository";
import { and, eq, sql } from "drizzle-orm";
import { type Db, withClient, withDb } from "../../db/pool";
import { externalTasks, users } from "../../db/schema";
import type { JobMessage } from "../../lib/job-message";
import type { Bindings } from "../../types/bindings";



/** attempts is a monotonic fencing token: an older claimant cannot update a new lease. */






const MAX_EXTERNAL_TASK_ATTEMPTS = 48;

/**
 * リース満了までの猶予。下の各クエリの `INTERVAL '5 minutes'` と同じ値であること。
 * TASK_SCHEDULER は、この猶予を過ぎた lock を回収するために起床時刻を決める。
 */
export const EXTERNAL_TASK_LEASE_MS = 5 * 60 * 1000;



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
  params: { limit: number; taskId?: number; excludeTaskIds?: readonly number[] },
): Promise<ClaimedExternalTask[]> {
  return withClient(env, async (client) => {
    const result = await client.query<{
      id: string;
      attempts: number;
      kind: ExternalTaskKind;
      payload: Record<string, unknown>;
    }>(
      `WITH candidates AS (
           SELECT id
             FROM external_tasks
            WHERE completed_at IS NULL
              AND dead_at IS NULL
            AND available_at <= now()
            AND NOT (id = ANY($3::bigint[]))
            AND (locked_at IS NULL OR locked_at < now() - INTERVAL '5 minutes')
            AND ($2::bigint IS NULL OR id = $2)
          ORDER BY available_at, id
          FOR UPDATE SKIP LOCKED
          LIMIT $1
       )
       UPDATE external_tasks AS task
          SET locked_at = now(),
              attempts = attempts + 1,
              updated_at = now()
         FROM candidates
        WHERE task.id = candidates.id
      RETURNING task.id, task.attempts, task.kind, task.payload`,
      [params.limit, params.taskId ?? null, params.excludeTaskIds ?? []],
    );
    return result.rows.map((row) => ({
      id: Number(row.id),
      attempt: row.attempts,
      kind: row.kind,
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

      if (task.effectAppliedAt === null && params.bytes !== null && params.bytes > 0) {
        const remaining = sql`GREATEST(0, ${users.usedStorageBytes} - ${params.bytes})`;
        await tx
          .update(users)
          .set({
            usedStorageBytes: remaining,
            isOverQuota: sql`CASE
              WHEN ${users.isOverQuota}
               AND (
                 ${users.storageLimitGb} IS NULL
                 OR ${remaining} <= floor(${users.storageLimitGb} * 1073741824)
               )
              THEN false
              ELSE ${users.isOverQuota}
            END`,
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
  return withClient(env, async (client) => {
    const result = await client.query<{ dead: boolean }>(
      `UPDATE external_tasks
          SET locked_at = NULL,
              last_error = $2,
              dead_at = CASE WHEN attempts >= $3 THEN now() ELSE NULL END,
              available_at = CASE
                WHEN attempts >= $3 THEN available_at
                ELSE now()
                  + LEAST(3600, 5 * (2 ^ LEAST(attempts, 10))) * INTERVAL '1 second'
              END,
              updated_at = now()
        WHERE id = $1 AND attempts = $4
          AND locked_at > clock_timestamp() - INTERVAL '5 minutes'
          AND completed_at IS NULL AND dead_at IS NULL
    RETURNING dead_at IS NOT NULL AS dead`,
      [lease.id, error.slice(0, 2000), MAX_EXTERNAL_TASK_ATTEMPTS, lease.attempt],
    );
    return { dead: result.rows[0]?.dead === true, leaseLost: result.rows.length === 0 };
  });
}

/** Workers Logs向けの小さなbacklog snapshot。監視系を業務処理へ混ぜない。 */
export async function getExternalTaskHealth(env: Bindings): Promise<ExternalTaskHealth> {
  return withClient(env, async (client) => {
    const result = await client.query<{
      pending: string;
      dead: string;
      oldest_pending_seconds: string | null;
    }>(
      `SELECT COUNT(*) FILTER (
                WHERE completed_at IS NULL AND dead_at IS NULL
              )::text AS pending,
              COUNT(*) FILTER (WHERE dead_at IS NOT NULL)::text AS dead,
              EXTRACT(EPOCH FROM now() - MIN(created_at) FILTER (
                WHERE completed_at IS NULL AND dead_at IS NULL
              ))::text AS oldest_pending_seconds
         FROM external_tasks`,
    );
    const row = result.rows[0];
    return {
      pending: Number(row?.pending ?? 0),
      dead: Number(row?.dead ?? 0),
      oldestPendingSeconds:
        row?.oldest_pending_seconds == null
          ? null
          : Number(row.oldest_pending_seconds),
    };
  });
}

/** SQS最大保持期間より長い30日を過ぎた完了台帳だけを、小分けで削除する。 */
export async function pruneDeliveryHistory(
  env: Bindings,
  retentionDays = 30,
  limit = 500,
): Promise<{ externalTasks: number; jobExecutions: number }> {
  if (!Number.isSafeInteger(retentionDays) || retentionDays < 1) {
    throw new Error("retentionDays must be a positive integer.");
  }
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 5000) {
    throw new Error("limit must be an integer between 1 and 5000.");
  }
  return withClient(env, async (client) => {
    const external = await client.query(
      `WITH victims AS (
         SELECT id
           FROM external_tasks
          WHERE completed_at < now() - ($1 * INTERVAL '1 day')
          ORDER BY completed_at, id
          LIMIT $2
       )
       DELETE FROM external_tasks AS task
        USING victims
        WHERE task.id = victims.id
    RETURNING task.id`,
      [retentionDays, limit],
    );
    const jobs = await client.query(
      `WITH victims AS (
         SELECT candidate.job_id
           FROM job_executions AS candidate
          WHERE candidate.completed_at < now() - ($1 * INTERVAL '1 day')
            AND NOT EXISTS (
                  SELECT 1
                    FROM external_tasks AS task
                   WHERE task.kind = 'sqs_job'
                     AND task.completed_at IS NULL
                     AND task.payload->'message'->>'job_id' = candidate.job_id
                )
          ORDER BY candidate.completed_at, candidate.job_id
          LIMIT $2
       )
       DELETE FROM job_executions AS job
        USING victims
        WHERE job.job_id = victims.job_id
    RETURNING job.job_id`,
      [retentionDays, limit],
    );
    return {
      externalTasks: external.rowCount ?? 0,
      jobExecutions: jobs.rowCount ?? 0,
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
        ...(params.multipartUploadId ? { multipart_upload_id: params.multipartUploadId } : {}),
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
  if (existing.length === 0) throw new Error("Storage cleanup task disappeared.");
  return Number(existing[0].id);
}

export function createPostgresExternalTaskRepository(env: Bindings): ExternalTaskRepository {
 return {
  createJob: params=>createJobTask(env,params), claim: params=>claimExternalTasks(env,params),
  complete: lease=>completeExternalTask(env,lease),
  async defer(lease,delayMs){
   if(!Number.isSafeInteger(delayMs)||delayMs<1||delayMs>86400000)throw new Error('Invalid external task deferral');
   await withDb(env,async db=>{
    const rows=await db.update(externalTasks).set({availableAt:sql`clock_timestamp()+(${delayMs}*interval '1 millisecond')`,lockedAt:null,lastError:'',updatedAt:sql`clock_timestamp()`})
      .where(externalTaskLeaseCondition(lease)).returning({id:externalTasks.id});
    if(!rows.length)throw new ExternalTaskLeaseLostError();
   });
  },
  completeStorageCleanup: params=>completeStorageCleanupTask(env,params),
  fail: (lease,error)=>failExternalTask(env,lease,error), health: ()=>getExternalTaskHealth(env),
  pruneHistory: (days,limit)=>pruneDeliveryHistory(env,days,limit),
 };
}
