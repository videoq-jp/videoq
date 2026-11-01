import { DurableObject } from "cloudflare:workers";
import { pruneExpiredHistory } from "../lib/rate-limit";

/**
 * 固定キー単位のスライディング・ウィンドウ・レート制限。
 * Worker 側は `idFromName(scope:ident)` で 1 キー = 1 DO にシャーディングする。
 */
export class RateLimiter extends DurableObject {
  /**
   * `cost` リクエスト分をまとめて消費する。窓に収まらなければ 1 件も記録せず
   * `allowed: false` と Retry-After 秒を返す（部分消費はしない）。
   */
  async consume(
    limit: number,
    windowSec: number,
    cost = 1,
  ): Promise<{ allowed: boolean; retryAfterSec: number }> {
    const now = Date.now() / 1000;
    const history = pruneExpiredHistory(
      (await this.ctx.storage.get<number[]>("history")) ?? [],
      now,
      windowSec,
    );

    if (history.length + cost > limit) {
      const oldest = history[history.length - 1];
      // 窓が空でも 1 回で使い切れない要求は、待っても通らないので即座に拒否する。
      const retryAfterSec =
        oldest === undefined
          ? windowSec
          : Math.max(1, Math.ceil(windowSec - (now - oldest)));
      return { allowed: false, retryAfterSec };
    }

    for (let i = 0; i < cost; i++) history.unshift(now);
    await this.ctx.storage.put({ history, windowSec });
    const oldest = history[history.length - 1];
    await this.ctx.storage.setAlarm((oldest + windowSec) * 1000);
    return { allowed: true, retryAfterSec: 0 };
  }

  /**
   * 直前に消費した `cost` 件を取り消す。複数スコープを順に消費する呼び出し元が、
   * 後続スコープで拒否されたときに先行分を返すための best-effort な補償。
   * 窓から溢れて既に消えている分は、単に取り消す対象が無いだけで無害。
   */
  async release(windowSec: number, cost: number): Promise<void> {
    const stored = await this.ctx.storage.get<number[]>("history");
    if (!stored?.length) return;
    const history = pruneExpiredHistory(stored, Date.now() / 1000, windowSec);
    // newest-first なので、返すのは先頭（最も新しい消費）から。
    history.splice(0, Math.min(cost, history.length));
    if (history.length === 0) {
      await this.ctx.storage.deleteAll();
      return;
    }
    await this.ctx.storage.put({ history, windowSec });
  }

  /**
   * 現在の窓に残る消費数の読み取り専用スナップショット。
   * Better Auth の非原子的フォールバック経路（`get`/`set`）専用。
   */
  async snapshot(): Promise<{ count: number; lastRequestMs: number } | null> {
    const [stored, windowSec] = await Promise.all([
      this.ctx.storage.get<number[]>("history"),
      this.ctx.storage.get<number>("windowSec"),
    ]);
    if (!stored?.length || !windowSec) return null;
    const history = pruneExpiredHistory(stored, Date.now() / 1000, windowSec);
    if (history.length === 0) return null;
    return { count: history.length, lastRequestMs: history[0] * 1000 };
  }

  /** 上限判定なしで 1 件記録する。`snapshot` と同じフォールバック経路専用。 */
  async record(windowSec: number): Promise<void> {
    await this.consume(Number.MAX_SAFE_INTEGER, windowSec);
  }

  async alarm(): Promise<void> {
    const [storedHistory, windowSec] = await Promise.all([
      this.ctx.storage.get<number[]>("history"),
      this.ctx.storage.get<number>("windowSec"),
    ]);
    if (!storedHistory?.length || !windowSec) {
      await this.ctx.storage.deleteAll();
      return;
    }
    const history = pruneExpiredHistory(
      storedHistory,
      Date.now() / 1000,
      windowSec,
    );
    if (history.length === 0) {
      await this.ctx.storage.deleteAll();
      return;
    }
    await this.ctx.storage.put("history", history);
    const oldest = history[history.length - 1];
    await this.ctx.storage.setAlarm((oldest + windowSec) * 1000);
  }
}
