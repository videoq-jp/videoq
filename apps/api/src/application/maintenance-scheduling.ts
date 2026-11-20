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

