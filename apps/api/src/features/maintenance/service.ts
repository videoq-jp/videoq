import type { MaintenanceDependencies } from './ports';
import type { ExternalTaskRunResult } from '../tasks/service';
import type { ReconcileResult } from './upload-reconcile-service';

export const RETENTION_CRON = '17 3 * * *';
const BACKLOG_WARNING_SECONDS = 15 * 60;
export const INVITATION_QUEUED_STALE_MS = 15 * 60 * 1000;

async function observeExternalTaskHealth(deps: MaintenanceDependencies) {
  const health = await deps.health();
  if (
    health.dead > 0 ||
    (health.oldestPendingSeconds !== null &&
      health.oldestPendingSeconds >= BACKLOG_WARNING_SECONDS)
  ) {
    deps.report("external_task_backlog_warning", { ...health }, true);
  }
  return health;
}

async function settleAndReport(
  deps: MaintenanceDependencies,
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
        : { error: "Maintenance operation failed" },
    ]),
  );
  // Driver/provider messages and nested causes can contain bound tokens or
  // scene data. Do not retain them in AggregateError: runtimes log rejections.
  const failures = settled.flatMap((result, index): Error[] =>
    result.status === "rejected" ? [new Error(`${entries[index][0]} failed`)] : [],
  );


  if (failures.length > 0) {
    deps.report(event, results, true);
    throw new AggregateError(failures, `${event} failed`);
  }
  deps.report(event, results, false);
  return results;
}

export type MaintenanceSweepResult = {
  /** 一件でも前に進んだか。空振りが続くときだけ起床間隔を広げるための判定。 */
  progressed: boolean;
};

function sweepProgressed(results: Record<string, unknown>): boolean {
  const materials = results.ltiMaterials as { synchronized?: number } | undefined;
  const tasks = results.externalTasks as ExternalTaskRunResult | undefined;
  const uploads = results.abandonedUploads as ReconcileResult | undefined;
  const visualObjects = results.visualObjects as {claimed?:number} | undefined;
  const sceneIndex = results.sceneIndex as { claimed?: number; reconciled?: number; verified?: number; repairQueued?: number } | undefined;
  const policy = results.operationalPolicy as { delivered?: number } | undefined;
  const invitations = results.staleInvitations as { failed?: number } | undefined;
  return (
    (policy?.delivered ?? 0) > 0 ||
    (materials?.synchronized ?? 0) > 0 ||
    (tasks?.claimed ?? 0) > 0 ||
    (sceneIndex?.claimed ?? 0) > 0 || (sceneIndex?.reconciled ?? 0) > 0 || (sceneIndex?.verified ?? 0) > 0 || (sceneIndex?.repairQueued ?? 0) > 0 ||
    (visualObjects?.claimed ?? 0) > 0 ||
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
  deps: MaintenanceDependencies,
  now: Date,
): Promise<MaintenanceSweepResult> {
  if (deps.paused) return { progressed: false };
  const results = await settleAndReport(deps, "scheduled_delivery_recovery", {
    externalTasks: deps.recoverTasks(),
    sceneIndex: deps.maintainScenes(),
    visualObjects: deps.maintainVisuals(),
    ltiMaterials: deps.sweepMaterials(),
    abandonedUploads: deps.reconcileUploads(),
    staleInvitations: deps.failInvitations(
      now,
      INVITATION_QUEUED_STALE_MS,
    ),
    health: observeExternalTaskHealth(deps),
    operationalPolicy: deps.observePolicy?.(now) ?? Promise.resolve({status:"unconfigured"}),
    courseSkills: deps.reconcileSkills?.() ?? Promise.resolve({ checked: 0 }),
  });
  return { progressed: sweepProgressed(results) };
}

/**
 * 残った唯一の cron。保持期間の掃除に加えて、アラームを張り損ねた回復対象を
 * 拾い直す最終防衛線を兼ねる。5分ポーリングは TASK_SCHEDULER が置き換えた。
 */
export async function runScheduledMaintenance(
  deps: MaintenanceDependencies,
  cron: string,
  now: Date,
): Promise<void> {
  if (deps.paused) return;
  if (cron !== RETENTION_CRON) {
    throw new Error(`Unknown scheduled maintenance cron: ${cron}`);
  }

  // 掃除と回復は独立。片方が失敗しても、もう片方を落とさない。
  const [retention, sweep] = await Promise.allSettled([
    settleAndReport(deps, "scheduled_delivery_retention", {
      retention: deps.pruneHistory(),
      mcpIdempotency: deps.pruneIdempotency(),
      conversations: deps.pruneConversations(),
      ltiCredentials: deps.pruneCredentials(),
      ltiAudit: deps.pruneAudit(now),
    }),
    runMaintenanceSweep(deps, now),
  ]);

  // 回復が空振り・失敗でも張り直す。ここを飛ばすと、アラームを失った対象が
  // 次の日次 cron まで放置される。
  await deps.refresh(
    sweep.status === "fulfilled" && sweep.value.progressed,
  ).catch(() => { throw new Error("Maintenance schedule refresh failed"); });

  const failures = [retention, sweep].flatMap((result): unknown[] =>
    result.status === "rejected" ? [result.reason] : [],
  );
  if (failures.length > 0) {
    throw new AggregateError(failures, "scheduled maintenance failed");
  }
}
