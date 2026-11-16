import { applicationTrafficPaused } from "../lib/migration-traffic";
import { DurableObject } from "cloudflare:workers";
import {
  ARM_FLOOR_MS,
  chooseWakeup,
  nextIdleStrikes,
} from "../lib/task-scheduler";
import type { Bindings } from "../types/bindings";

const STRIKES_KEY = "idleStrikes";

/**
 * 回復処理の起床係。単一インスタンスで「次に起きるべき時刻」だけを持つ。
 *
 * 5分ごとのポーリング cron を置き換える。回復対象が無い間はアラームを張らない
 * ため DB へのアクセスが完全に止まり、Neon がサスペンドできる。
 *
 * DB 層（pg / repositories）を動的に読むのは、Workers ランタイムテストの都合。
 * `test/workers/worker.ts` は app を経由しないため、静的 import にすると pg を
 * 解決できずテストファイルごと落ちる。本番では `src/index.ts` が同じバンドルで
 * pg を静的に読むので、遅延させても起動コストは変わらない。
 *
 * 裏を返すと `alarm` / `reschedule` の実行時経路はテストで踏めていない。
 * 判断ロジックは lib/task-scheduler.ts の純粋関数に、クエリは
 * maintenance-schedule.integration.test.ts に切り出して個別に検証している。
 */
export class TaskScheduler extends DurableObject<Bindings> {
  /**
   * 遅くとも `atMs` までに一度起きる。既存アラームの方が早ければ何もしない
   * （最短時刻が常に勝つ）ので、呼び出し側は重複を気にしなくてよい。
   */
  async armAt(atMs: number): Promise<void> {
    const target = Math.max(atMs, Date.now() + ARM_FLOOR_MS);
    const current = await this.ctx.storage.getAlarm();
    if (current !== null && current <= target) return;
    await this.ctx.storage.setAlarm(target);
  }

  /**
   * 回復処理の直後に、次回の起床時刻を DB から引き直す。日次 cron の
   * セーフティネットからも呼ばれる。
   */
  async reschedule(progressed: boolean): Promise<void> {
    await this.settle(progressed);
  }

  async alarm(): Promise<void> {
    if (applicationTrafficPaused(this.env)) {
      await this.ctx.storage.setAlarm(Date.now() + 60_000);
      return;
    }
    const { runMaintenanceSweep } = await import("../lib/scheduled-maintenance");
    // 失敗時は DO のアラーム再試行に任せる。再試行が尽きても日次 cron が拾う。
    const sweep = await runMaintenanceSweep(this.env);
    await this.settle(sweep.progressed);
  }

  /**
   * 次の起床時刻を DB から決める。対象が残っていなければアラームを張らない。
   *
   * 回復できない行が残り続けると「起きる → 何もできない → すぐ起きる」の
   * 空振りループになり得るので、前に進まなかった回数に応じて最小間隔を広げる。
   *
   * DB への問い合わせ中は再入を止められない。その間に `armAt` が予約した起床を
   * 壊さないよう、ストレージ操作は問い合わせの後にまとめ、既存より後ろへ動かす
   * ことも消すこともしない。
   */
  private async settle(progressed: boolean): Promise<void> {
    if (applicationTrafficPaused(this.env)) {
      await this.armAt(Date.now() + 60_000);
      return;
    }
    const [{ MAINTENANCE_WINDOWS }, { getNextMaintenanceWakeup }] = await Promise.all([
      import("../lib/scheduled-maintenance"),
      import("../repositories/maintenance-schedule-repository"),
    ]);
    const { nextAt, nextFutureAt } = await getNextMaintenanceWakeup(
      this.env,
      MAINTENANCE_WINDOWS,
    );

    // ここから先は await の合間に他のイベントを挟まない（input gate 内で完結）。
    const previous = (await this.ctx.storage.get<number>(STRIKES_KEY)) ?? 0;
    const pendingAlarm = await this.ctx.storage.getAlarm();
    const now = Date.now();
    const strikes = nextIdleStrikes({
      progressed,
      overdue: nextAt !== null && nextAt.getTime() <= now,
      previous,
    });
    const target = chooseWakeup({
      nextAt: nextAt === null ? null : nextAt.getTime(),
      nextFutureAt: nextFutureAt === null ? null : nextFutureAt.getTime(),
      pendingAlarm,
      strikes,
      now,
    });

    if (nextAt === null) {
      await this.ctx.storage.delete(STRIKES_KEY);
    } else {
      await this.ctx.storage.put(STRIKES_KEY, strikes);
    }
    if (target !== null) await this.ctx.storage.setAlarm(target);
  }
}
