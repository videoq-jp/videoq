import {
  externalTaskFailure,
  storageCleanupRefundRequired,
  storageCleanupState,
  validateExternalTaskDeferral,
} from "../../application/external-task-policy";
import { storageCleanupDrizzleLogic } from "../external-task-policy-sql";
import { retentionBounds } from "../../features/maintenance/policy";
import {
  and,
  eq,
  sql,
  or,
  isNull,
  isNotNull,
  exists,
  notExists,
  inArray,
  notInArray,
} from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import { createD1Connection } from "../../db/d1/connection";
import { insertSelectFields, runD1Batch } from "../../db/d1/query-builders";
import {
  externalTasks,
  users,
  mutationReceipts as receipts,
  jobExecutions,
} from "../../db/schema/sqlite";
import {
  ExternalTaskLeaseLostError,
  type ExternalTaskLease,
  type ExternalTaskKind,
  type ExternalTaskRepository,
} from "../contracts/external-task-repository";

export function createD1ExternalTaskRepository(
  database: D1Database,
): ExternalTaskRepository {
  const db = createD1Connection(database);
  const now = sql<string>`strftime('%Y-%m-%dT%H:%M:%fZ','now')`;
  const owns = (lease: ExternalTaskLease) =>
    and(
      eq(externalTasks.id, lease.id),
      eq(externalTasks.attempts, lease.attempt),
      sql`julianday(${externalTasks.lockedAt})>julianday('now')-5.0/1440`,
      isNull(externalTasks.completedAt),
      isNull(externalTasks.deadAt),
    );
  return {
    async createJob({ message, dedupeKey = `job:${message.job_id}` }) {
      const [inserted] = await db
        .insert(externalTasks)
        .values({ kind: "sqs_job", payload: { message }, dedupeKey })
        .onConflictDoNothing()
        .returning({ id: externalTasks.id });
      if (inserted) return { id: inserted.id, created: true };
      const existing = await db
        .select({ id: externalTasks.id })
        .from(externalTasks)
        .where(eq(externalTasks.dedupeKey, dedupeKey))
        .get();
      if (!existing) throw new Error("External job task disappeared.");
      return { id: existing.id, created: false };
    },
    async claim({ limit, taskId, excludeTaskIds = [] }) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
        throw new Error("Invalid external task limit");
      const excluded = db
        .select({ id: sql<number>`value` })
        .from(sql`json_each(${JSON.stringify(excludeTaskIds)})`);
      const candidates = db
        .select({ id: externalTasks.id })
        .from(externalTasks)
        .where(
          and(
            isNull(externalTasks.completedAt),
            isNull(externalTasks.deadAt),
            sql`julianday(${externalTasks.availableAt})<=julianday('now')`,
            or(
              isNull(externalTasks.lockedAt),
              sql`julianday(${externalTasks.lockedAt})<julianday('now')-5.0/1440`,
            ),
            taskId === undefined ? undefined : eq(externalTasks.id, taskId),
            notInArray(externalTasks.id, excluded),
          ),
        )
        .orderBy(externalTasks.availableAt, externalTasks.id)
        .limit(limit);
      const rows = await db
        .update(externalTasks)
        .set({
          lockedAt: now,
          attempts: sql`${externalTasks.attempts}+1`,
          updatedAt: now,
        })
        .where(inArray(externalTasks.id, candidates))
        .returning({
          id: externalTasks.id,
          attempts: externalTasks.attempts,
          kind: externalTasks.kind,
          payload: externalTasks.payload,
        });
      return rows.map((row) => ({
        id: row.id,
        attempt: row.attempts,
        kind: row.kind as ExternalTaskKind,
        payload: row.payload,
      }));
    },
    async defer(lease, delayMs) {
      validateExternalTaskDeferral(delayMs);
      const result = await db
        .update(externalTasks)
        .set({
          availableAt: sql`strftime('%Y-%m-%dT%H:%M:%fZ','now',${delayMs / 1000}||' seconds')`,
          lockedAt: null,
          lastError: "",
          updatedAt: now,
        })
        .where(owns(lease))
        .run();
      if (!result.meta.changes) throw new ExternalTaskLeaseLostError();
    },
    async complete(lease) {
      const rows = await db
        .update(externalTasks)
        .set({
          completedAt: now,
          lockedAt: null,
          lastError: "",
          updatedAt: now,
        })
        .where(owns(lease))
        .returning({ id: externalTasks.id });
      if (!rows.length) throw new ExternalTaskLeaseLostError();
    },
    async completeStorageCleanup({ lease, userId, bytes }) {
      if (bytes !== null && (!Number.isSafeInteger(bytes) || bytes < 0))
        throw new Error("Invalid storage cleanup bytes");
      const token = crypto.randomUUID();
      const cleanup = storageCleanupState(
        {
          used: sql`${users.usedStorageBytes}`,
          refunded: sql`${bytes ?? 0}`,
          limitGb: sql`${users.storageLimitGb}`,
          overQuota: sql`${users.isOverQuota}`,
        },
        {
          ...storageCleanupDrizzleLogic,
          remaining: (used, refunded) => sql`max(0,${used}-${refunded})`,
        },
      );
      const results = await runD1Batch(database, [
        db.insert(receipts).select(
          db
            .select(
              insertSelectFields(receipts, {
                token: sql`${token}`,
                kind: sql`'storage_cleanup'`,
                resourceId: externalTasks.id,
                effectApplied: isNotNull(externalTasks.effectAppliedAt),
              }),
            )
            .from(externalTasks)
            .where(owns(lease)),
        ),
        db
          .update(users)
          .set({
            usedStorageBytes: cleanup.remaining,
            isOverQuota: cleanup.overQuota,
          })
          .where(
            and(
              eq(users.id, userId),
              sql`${Number(storageCleanupRefundRequired(bytes))}`,
              exists(
                db
                  .select({ token: receipts.token })
                  .from(receipts)
                  .where(
                    and(
                      eq(receipts.token, token),
                      eq(receipts.effectApplied, false),
                    ),
                  ),
              ),
            ),
          ),
        db
          .update(externalTasks)
          .set({
            effectAppliedAt: sql`coalesce(${externalTasks.effectAppliedAt},${now})`,
            completedAt: now,
            lockedAt: null,
            lastError: "",
            updatedAt: now,
          })
          .where(
            and(
              eq(externalTasks.id, lease.id),
              exists(
                db
                  .select({ token: receipts.token })
                  .from(receipts)
                  .where(
                    and(
                      eq(receipts.token, token),
                      eq(receipts.resourceId, externalTasks.id),
                    ),
                  ),
              ),
            ),
          )
          .returning({ id: externalTasks.id }),
        db.delete(receipts).where(eq(receipts.token, token)),
      ]);
      if (!results[2].results.length) throw new ExternalTaskLeaseLostError();
    },
    async fail(lease, error) {
      const failure = externalTaskFailure(lease.attempt);
      const rows = await db
        .update(externalTasks)
        .set({
          lockedAt: null,
          lastError: error.slice(0, 2000),
          deadAt: failure.dead ? now : null,
          availableAt: failure.dead
            ? sql`${externalTasks.availableAt}`
            : sql`strftime('%Y-%m-%dT%H:%M:%fZ','now','+'||${failure.delaySeconds}||' seconds')`,
          updatedAt: now,
        })
        .where(owns(lease))
        .returning({ dead: isNotNull(externalTasks.deadAt) });
      return { dead: Boolean(rows[0]?.dead), leaseLost: rows.length === 0 };
    },
    async health() {
      const pending = and(
        isNull(externalTasks.completedAt),
        isNull(externalTasks.deadAt),
      );
      const row = await db
        .select({
          pending: sql<number>`count(*) FILTER(WHERE ${pending})`,
          dead: sql<number>`count(*) FILTER(WHERE ${isNotNull(externalTasks.deadAt)})`,
          oldest: sql<
            number | null
          >`(julianday('now')-julianday(min(${externalTasks.createdAt}) FILTER(WHERE ${pending})))*86400`,
        })
        .from(externalTasks)
        .get();
      return {
        pending: row?.pending ?? 0,
        dead: row?.dead ?? 0,
        oldestPendingSeconds: row?.oldest ?? null,
      };
    },
    async pruneHistory(retentionDays, limit) {
      const bounds = retentionBounds(retentionDays, limit),
        candidate = alias(jobExecutions, "candidate");
      const victims = db
        .select({ id: externalTasks.id })
        .from(externalTasks)
        .where(
          sql`julianday(${externalTasks.completedAt})<julianday('now')-${bounds.retentionDays}`,
        )
        .orderBy(externalTasks.completedAt, externalTasks.id)
        .limit(bounds.limit);
      const jobs = db
        .select({ id: candidate.jobId })
        .from(candidate)
        .where(
          and(
            sql`julianday(${candidate.completedAt})<julianday('now')-${bounds.retentionDays}`,
            notExists(
              db
                .select({ id: externalTasks.id })
                .from(externalTasks)
                .where(
                  and(
                    eq(externalTasks.kind, "sqs_job"),
                    isNull(externalTasks.completedAt),
                    sql`json_extract(${externalTasks.payload},'$.message.job_id')=${candidate.jobId}`,
                  ),
                ),
            ),
          ),
        )
        .orderBy(candidate.completedAt, candidate.jobId)
        .limit(bounds.limit);
      const result = await runD1Batch(database, [
        db
          .delete(externalTasks)
          .where(inArray(externalTasks.id, victims))
          .returning({ id: externalTasks.id }),
        db
          .delete(jobExecutions)
          .where(inArray(jobExecutions.jobId, jobs))
          .returning({ id: jobExecutions.jobId }),
      ]);
      return {
        externalTasks: result[0].results.length,
        jobExecutions: result[1].results.length,
      };
    },
  };
}
