import { and, eq, sql } from "drizzle-orm";
import { createD1Connection } from "../../db/d1/connection";
import { externalTasks } from "../../db/schema/sqlite";
import {
  ExternalTaskLeaseLostError, type ExternalTaskLease, type ExternalTaskKind, type ExternalTaskRepository,
} from "../contracts/external-task-repository";

const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";
const LIVE_LEASE = "id=? AND attempts=? AND julianday(locked_at)>julianday('now')-5.0/1440 AND completed_at IS NULL AND dead_at IS NULL";

export function createD1ExternalTaskRepository(database: D1Database): ExternalTaskRepository {
  const db = createD1Connection(database);
  const owns = (lease: ExternalTaskLease) => and(eq(externalTasks.id, lease.id), eq(externalTasks.attempts, lease.attempt),
    sql`julianday(${externalTasks.lockedAt})>julianday('now')-5.0/1440`,
    sql`${externalTasks.completedAt} IS NULL AND ${externalTasks.deadAt} IS NULL`);
  return {
    async createJob({ message, dedupeKey = `job:${message.job_id}` }) {
      const inserted = await db.insert(externalTasks).values({ kind: "sqs_job", payload: { message }, dedupeKey })
        .onConflictDoNothing().returning({ id: externalTasks.id });
      if (inserted.length) return { id: inserted[0].id, created: true };
      const [existing] = await db.select({ id: externalTasks.id }).from(externalTasks).where(eq(externalTasks.dedupeKey, dedupeKey)).limit(1);
      if (!existing) throw new Error("External job task disappeared.");
      return { id: existing.id, created: false };
    },
    async claim({ limit, taskId, excludeTaskIds = [] }) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("Invalid external task limit");
      const { results } = await database.prepare(`UPDATE external_tasks SET locked_at=${NOW},attempts=attempts+1,updated_at=${NOW}
        WHERE id IN (SELECT id FROM external_tasks
          WHERE completed_at IS NULL AND dead_at IS NULL AND julianday(available_at)<=julianday('now')
            AND (locked_at IS NULL OR julianday(locked_at)<julianday('now')-5.0/1440)
            AND (? IS NULL OR id=?) AND id NOT IN (SELECT value FROM json_each(?))
          ORDER BY available_at,id LIMIT ?)
        RETURNING id,attempts,kind,payload`).bind(taskId ?? null, taskId ?? null, JSON.stringify(excludeTaskIds), limit)
        .all<{ id: number; attempts: number; kind: ExternalTaskKind; payload: string }>();
      return results.map(row => ({ id: row.id, attempt: row.attempts, kind: row.kind, payload: JSON.parse(row.payload) as Record<string, unknown> }));
    },
    async defer(lease,delayMs){
      if(!Number.isSafeInteger(delayMs)||delayMs<1||delayMs>86400000)throw new Error('Invalid external task deferral');
      const result=await database.prepare(`UPDATE external_tasks SET available_at=strftime('%Y-%m-%dT%H:%M:%fZ','now',?||' seconds'),locked_at=NULL,last_error='',updated_at=${NOW} WHERE ${LIVE_LEASE}`)
        .bind(delayMs/1000,lease.id,lease.attempt).run();
      if(!result.meta.changes)throw new ExternalTaskLeaseLostError();
    },
    async complete(lease) {
      const rows = await db.update(externalTasks).set({ completedAt: sql.raw(NOW), lockedAt: null, lastError: "", updatedAt: sql.raw(NOW) })
        .where(owns(lease)).returning({ id: externalTasks.id });
      if (!rows.length) throw new ExternalTaskLeaseLostError();
    },
    async completeStorageCleanup({ lease, userId, bytes }) {
      if (bytes !== null && (!Number.isSafeInteger(bytes) || bytes < 0)) throw new Error("Invalid storage cleanup bytes");
      const token = crypto.randomUUID();
      const refund = bytes ?? 0;
      const remaining = "max(0,used_storage_bytes-?)";
      const results = await database.batch<Record<string, unknown>>([
        // Capture authorization once inside this batch. Later writes use the
        // receipt, so a clock boundary cannot split quota refund and completion.
        database.prepare(`INSERT INTO mutation_receipts (token,kind,resource_id,effect_applied)
          SELECT ?,'storage_cleanup',id,effect_applied_at IS NOT NULL FROM external_tasks WHERE ${LIVE_LEASE}`)
          .bind(token, lease.id, lease.attempt),
        database.prepare(`UPDATE users SET used_storage_bytes=${remaining},
          is_over_quota=CASE WHEN is_over_quota AND (storage_limit_gb IS NULL OR ${remaining}<=floor(storage_limit_gb*1073741824))
            THEN 0 ELSE is_over_quota END
          WHERE id=? AND ?>0 AND EXISTS(SELECT 1 FROM mutation_receipts WHERE token=? AND effect_applied=0)`)
          .bind(refund, refund, userId, refund, token),
        database.prepare(`UPDATE external_tasks SET effect_applied_at=coalesce(effect_applied_at,${NOW}),
          completed_at=${NOW},locked_at=NULL,last_error='',updated_at=${NOW}
          WHERE id=? AND EXISTS(SELECT 1 FROM mutation_receipts WHERE token=? AND resource_id=external_tasks.id)
          RETURNING id`).bind(lease.id, token),
        database.prepare("DELETE FROM mutation_receipts WHERE token=?").bind(token),
      ]);
      if (!results[2].results.length) throw new ExternalTaskLeaseLostError();
    },
    async fail(lease, error) {
      const { results } = await database.prepare(`UPDATE external_tasks SET locked_at=NULL,last_error=?,
        dead_at=CASE WHEN attempts>=48 THEN ${NOW} ELSE NULL END,
        available_at=CASE WHEN attempts>=48 THEN available_at ELSE
          strftime('%Y-%m-%dT%H:%M:%fZ','now','+'||min(3600,5*(1 << min(attempts,10)))||' seconds') END,
        updated_at=${NOW} WHERE ${LIVE_LEASE} RETURNING dead_at IS NOT NULL AS dead`)
        .bind(error.slice(0, 2000), lease.id, lease.attempt).all<{ dead: number }>();
      return { dead: results[0]?.dead === 1, leaseLost: results.length === 0 };
    },
    async health() {
      const row = await database.prepare(`SELECT count(*) FILTER(WHERE completed_at IS NULL AND dead_at IS NULL) AS pending,
        count(*) FILTER(WHERE dead_at IS NOT NULL) AS dead,
        (julianday('now')-julianday(min(created_at) FILTER(WHERE completed_at IS NULL AND dead_at IS NULL)))*86400 AS oldest
        FROM external_tasks`).first<{ pending: number; dead: number; oldest: number | null }>();
      return { pending: row?.pending ?? 0, dead: row?.dead ?? 0, oldestPendingSeconds: row?.oldest ?? null };
    },
    async pruneHistory(retentionDays = 30, limit = 500) {
      if (!Number.isSafeInteger(retentionDays) || retentionDays < 1) throw new Error("retentionDays must be a positive integer.");
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 5000) throw new Error("limit must be an integer between 1 and 5000.");
      const result = await database.batch([
        database.prepare(`DELETE FROM external_tasks WHERE id IN(SELECT id FROM external_tasks
          WHERE julianday(completed_at)<julianday('now')-? ORDER BY completed_at,id LIMIT ?) RETURNING id`).bind(retentionDays, limit),
        database.prepare(`DELETE FROM job_executions WHERE job_id IN(SELECT candidate.job_id FROM job_executions candidate
          WHERE julianday(candidate.completed_at)<julianday('now')-? AND NOT EXISTS(SELECT 1 FROM external_tasks task
            WHERE task.kind='sqs_job' AND task.completed_at IS NULL AND json_extract(task.payload,'$.message.job_id')=candidate.job_id)
          ORDER BY candidate.completed_at,candidate.job_id LIMIT ?) RETURNING job_id`).bind(retentionDays, limit),
      ]);
      return { externalTasks: result[0].results.length, jobExecutions: result[1].results.length };
    },
  };
}
