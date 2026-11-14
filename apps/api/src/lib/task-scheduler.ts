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

/** 過去時刻の setAlarm による即時再発火ループを避けるための最小猶予。 */
export const ARM_FLOOR_MS = 1_000;

/**
 * 即時実行が Worker ごと落ちた場合の保険。着手前に張っておき、
 * alarm 側が DB を真実の源として正確な時刻に張り直す。
 */
export const DISPATCH_SAFETY_NET_MS = 60_000;

/** 回復できない対象を起こし続けないための、空振り時の最小間隔。 */
export const IDLE_BACKOFF_BASE_MS = 60_000;
export const IDLE_BACKOFF_CAP_MS = 60 * 60_000;

/**
 * 空振りが続いたときの最小待機。期限切れのまま回復できない行が残っても、
 * 指数的に間隔が開くので DB を起こし続けることはない。
 */
export function idleBackoffMs(strikes: number): number {
  if (strikes <= 0) return ARM_FLOOR_MS;
  const scaled = IDLE_BACKOFF_BASE_MS * 2 ** Math.min(strikes - 1, 10);
  return Math.min(scaled, IDLE_BACKOFF_CAP_MS);
}

/**
 * 空振り回数の更新。
 *
 * 数えるのは「期限が来ているのに前へ進められなかった」回数だけ。未来の期限を
 * 待っているだけの回を数えると、バックオフが正当な起床まで遅らせてしまう。
 */
export function nextIdleStrikes(params: {
  progressed: boolean;
  overdue: boolean;
  previous: number;
}): number {
  if (params.progressed || !params.overdue) return 0;
  return params.previous + 1;
}

/**
 * 次にアラームを張るべき時刻。`null` は「張り直さない」（＝既存のアラームを
 * そのまま残す）を意味する。
 *
 * 常に最短時刻が勝ち、既存より後ろへ動かすことも消すこともしない。回復処理は
 * DB へ問い合わせる間に再入を許すので、その隙に予約された起床を、古い
 * スナップショットに基づく判断で壊してはならない。
 */
export function chooseWakeup(params: {
  /** DB が示す次の期限。対象が無ければ null。 */
  nextAt: number | null;
  /** DB 問い合わせ時点で未来だった最も早い期限。バックオフの上限に使う。 */
  nextFutureAt: number | null;
  /** 現在張られているアラーム。 */
  pendingAlarm: number | null;
  strikes: number;
  now: number;
}): number | null {
  if (params.nextAt === null) return null;

  const overdue = params.nextAt <= params.now;
  let target = overdue
    ? params.now + idleBackoffMs(params.strikes)
    : Math.max(params.nextAt, params.now + ARM_FLOOR_MS);

  if (params.nextFutureAt !== null) {
    // 期限切れ対象の空振りが続いても、別対象のリース満了や配送期限は守る。
    // 問い合わせ後に期限を迎えていた場合も、バックオフせず最小猶予で起こす。
    target = Math.min(
      target,
      Math.max(params.nextFutureAt, params.now + ARM_FLOOR_MS),
    );
  }

  if (params.pendingAlarm !== null && params.pendingAlarm <= target) return null;
  return target;
}

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
