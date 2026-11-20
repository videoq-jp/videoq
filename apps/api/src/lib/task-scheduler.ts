import type { Bindings } from "../types/bindings";

/**
 * 回復処理の起床管理。
 *
 * 通常配送は投入と同じリクエスト内で即時実行されるので、ここで扱うのは
 * 「即時実行が失敗・中断したぶんを、いつ拾い直すか」だけ。対象が無い間は
 * アラームを張らないため、DB は完全に無音になり Neon はサスペンドできる。
 */

/** 起床時刻は一箇所に集約する。DO は単一インスタンス。 */
const SCHEDULER_NAME = "default";

export { ARM_FLOOR_MS, DISPATCH_SAFETY_NET_MS, IDLE_BACKOFF_BASE_MS, IDLE_BACKOFF_CAP_MS,
  idleBackoffMs, nextIdleStrikes, chooseWakeup,
} from '../application/maintenance-scheduling';

function scheduler(env: Bindings) {
  if (!env.TASK_SCHEDULER) throw new Error("Maintenance scheduler is not configured");
  return env.TASK_SCHEDULER.getByName(SCHEDULER_NAME);
}

/**
 * 「遅くともこの時刻までに一度起きてほしい」を登録する。
 * 常に最短時刻が勝つので、重複して呼んでも起床回数は増えない。
 *
 * 失敗は握りつぶす。DB が真実の源であり、取りこぼしは次のアクティビティか
 * 日次 cron のセーフティネットが回収する。ここで例外を投げて、コミット済みの
 * 業務処理を巻き戻してはならない。
 */
export async function armMaintenance(env: Bindings, atMs: number): Promise<void> {
  // On-prem recovery is driven by a Kubernetes CronJob reading the same durable
  // DB outbox; it survives API restarts without process-local timers.
  if (env.RUNTIME === "node") return;
  try {
    await scheduler(env).armAt(atMs);
  } catch {
    console.error(
      JSON.stringify({
        event: "maintenance_arm_failed",
        atMs,
      }),
    );
  }
}

/**
 * 回復処理を走らせた直後に、次回の起床時刻を DB から引き直させる。
 * 対象が残っていなければアラームは張られない。
 */
export async function refreshMaintenanceSchedule(
  env: Bindings,
  progressed: boolean,
): Promise<void> {
  if (env.RUNTIME === "node") return;
  try {
    await scheduler(env).reschedule(progressed);
  } catch {
    console.error(
      JSON.stringify({
        event: "maintenance_reschedule_failed",
      }),
    );
  }
}
