import {
  EXTERNAL_TASK_LEASE_MS,
  getExternalTaskHealth,
  pruneDeliveryHistory,
} from "../repositories/external-task-repository";
import { failInvitationsWithoutLiveDelivery } from "../repositories/course-invitation-repository";
import type { MaintenanceWindows } from "../repositories/maintenance-schedule-repository";
import type { Bindings } from "../types/bindings";
import {
  processExternalTasks,
  type ExternalTaskRunResult,
} from "./external-tasks";
import {
  ABANDONED_UPLOAD_MS,
  reconcileAbandonedUploads,
  type ReconcileResult,
} from "./upload-reconcile";
import { pruneMcpIdempotencyRecords } from "../repositories/mcp-idempotency-repository";
import { refreshMaintenanceSchedule } from "./task-scheduler";

export const RETENTION_CRON = "17 3 * * *";
const BACKLOG_WARNING_SECONDS = 15 * 60;
/** 配送タスクが尽きた招待を failed に倒すまでの猶予。 */
export const INVITATION_QUEUED_STALE_MS = 15 * 60 * 1000;

/**
 * 回復対象の期限。TASK_SCHEDULER はこの値を使って次の起床時刻を求めるので、
 * 実際に回復を行う側の閾値と必ず同じものを渡す。
 */
export const MAINTENANCE_WINDOWS: MaintenanceWindows = {
  leaseMs: EXTERNAL_TASK_LEASE_MS,
  abandonedUploadMs: ABANDONED_UPLOAD_MS,
  staleInvitationMs: INVITATION_QUEUED_STALE_MS,
};

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

async function observeExternalTaskHealth(env: Bindings) {
  const health = await getExternalTaskHealth(env);
  if (
    health.dead > 0 ||
    (health.oldestPendingSeconds !== null &&
      health.oldestPendingSeconds >= BACKLOG_WARNING_SECONDS)
  ) {
    console.error(JSON.stringify({ event: "external_task_backlog_warning", ...health }));
  }
  return health;
}

async function settleAndReport(
  event: string,
  work: Record<string, Promise<unknown>>,
): Promise<Record<string, unknown>> {
  const entries = Object.entries(work);
  const settled = await Promise.allSettled(entries.map(([, promise]) => promise));
  const results = Object.fromEntries(
    settled.map((result, index) => [
      entries[index][0],
      result.status === "fulfilled"
        ? result.value
        : { error: errorMessage(result.reason) },
    ]),
  );
  const failures = settled.flatMap((result): unknown[] =>
    result.status === "rejected" ? [result.reason] : [],
  );

  const log = JSON.stringify({ event, ...results });
  if (failures.length > 0) {
    console.error(log);
    throw new AggregateError(failures, `${event} failed`);
  }
  console.log(log);
  return results;
}

export type MaintenanceSweepResult = {
  /** 一件でも前に進んだか。空振りが続くときだけ起床間隔を広げるための判定。 */
  progressed: boolean;
};

function sweepProgressed(results: Record<string, unknown>): boolean {
  const tasks = results.externalTasks as ExternalTaskRunResult | undefined;
  const uploads = results.abandonedUploads as ReconcileResult | undefined;
  const invitations = results.staleInvitations as { failed?: number } | undefined;
  return (
    (tasks?.claimed ?? 0) > 0 ||
    (uploads?.released ?? 0) > 0 ||
    (invitations?.failed ?? 0) > 0
  );
}

/**
 * 即時実行で取りこぼしたぶんの回復。TASK_SCHEDULER のアラームと日次 cron の
 * 両方から呼ばれる。通常配送はここを経由しない。
 *
 * 起床そのものは呼び出し側が管理するので、ここでは保険のアラームを張らない
 * （`arm: false`）。次回の起床時刻は回復後に DB から引き直す。
 */
export async function runMaintenanceSweep(
  env: Bindings,
  now = new Date(),
): Promise<MaintenanceSweepResult> {
  const results = await settleAndReport("scheduled_delivery_recovery", {
    externalTasks: processExternalTasks(env, { limit: 50, arm: false }),
    abandonedUploads: reconcileAbandonedUploads(env),
    staleInvitations: failInvitationsWithoutLiveDelivery(
      env,
      now,
      INVITATION_QUEUED_STALE_MS,
    ),
    health: observeExternalTaskHealth(env),
  });
  return { progressed: sweepProgressed(results) };
}

/**
 * 残った唯一の cron。保持期間の掃除に加えて、アラームを張り損ねた回復対象を
 * 拾い直す最終防衛線を兼ねる。5分ポーリングは TASK_SCHEDULER が置き換えた。
 */
export async function runScheduledMaintenance(
  env: Bindings,
  cron: string,
  now = new Date(),
): Promise<void> {
  if (cron !== RETENTION_CRON) {
    throw new Error(`Unknown scheduled maintenance cron: ${cron}`);
  }

  // 掃除と回復は独立。片方が失敗しても、もう片方を落とさない。
  const [retention, sweep] = await Promise.allSettled([
    settleAndReport("scheduled_delivery_retention", {
      retention: pruneDeliveryHistory(env),
      mcpIdempotency: pruneMcpIdempotencyRecords(env),
    }),
    runMaintenanceSweep(env, now),
  ]);

  // 回復が空振り・失敗でも張り直す。ここを飛ばすと、アラームを失った対象が
  // 次の日次 cron まで放置される。
  await refreshMaintenanceSchedule(
    env,
    sweep.status === "fulfilled" && sweep.value.progressed,
  );

  const failures = [retention, sweep].flatMap((result): unknown[] =>
    result.status === "rejected" ? [result.reason] : [],
  );
  if (failures.length > 0) {
    throw new AggregateError(failures, "scheduled maintenance failed");
  }
}
