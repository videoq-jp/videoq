import { consumptionRetryAfter, consumptionTime, consumptionEntries, refundReservation, validateRateLimit, pruneExpiredHistory, type RateLimitEntry } from './rate-limit-history';
export { pruneExpiredHistory } from './rate-limit-history';
import type { Context } from "hono";
import { PUBLIC_DEMO_SHARE_SLUG } from "@videoq/trpc/public-demo";
import type { AppEnv, Bindings } from "../types/bindings";

/**
 * VideoQ API のスコープ別レート制限。
 */
export { THROTTLE_RATES, type ThrottleCheck } from '../domain/operations/throttle-policy';
import { throttleConsumption, chatThrottlePolicy, type ThrottleCheck } from '../domain/operations/throttle-policy';

export type ConsumeResult = { allowed: boolean; retryAfterSec: number };

type RateLimitSnapshot = { count: number; lastRequestMs: number };

export type RateLimitBackend = {
  consume(
    key: string,
    limit: number,
    windowSec: number,
    cost?: number,
    reservationId?: string,
  ): Promise<ConsumeResult>;
  /** 指定予約の消費だけを取り消す（期限切れ・二重返却はno-op）。 */
  release(key: string, windowSec: number, reservationId: string): Promise<void>;
  /** 消費せずに現在の窓を読む。非原子的フォールバック経路専用。 */
  snapshot(key: string): Promise<RateLimitSnapshot | null>;
  /** 上限判定なしで 1 件記録する。非原子的フォールバック経路専用。 */
  record(key: string, windowSec: number): Promise<void>;
};

/** Unit tests must explicitly inject this isolated backend through Bindings. */
export function createMemoryRateLimitBackend(): RateLimitBackend {
  const store = new Map<string, { history: RateLimitEntry[]; windowSec: number }>();
  const prune = (key: string, nowSec: number, windowSec: number): RateLimitEntry[] =>
    pruneExpiredHistory(store.get(key)?.history ?? [], nowSec, windowSec);

  return {
    // eslint-disable-next-line @typescript-eslint/require-await -- Preserve the asynchronous interface and rejection semantics.
    async consume(key, limit, windowSec, cost = 1, reservationId) {
      validateRateLimit(limit, windowSec, cost);
      const now = Date.now() / 1000;
      const history = prune(key, now, windowSec);
      if (history.length + cost > limit) {
        return { allowed: false, retryAfterSec: consumptionRetryAfter(history, now, windowSec, limit, cost) };
      }
      history.unshift(...consumptionEntries(now, cost, reservationId));
      store.set(key, { history, windowSec });
      return { allowed: true, retryAfterSec: 0 };
    },
    // eslint-disable-next-line @typescript-eslint/require-await -- Preserve the asynchronous interface and rejection semantics.
    async release(key, windowSec, reservationId) {
      const history = refundReservation(prune(key, Date.now() / 1000, windowSec), reservationId);
      if (history.length === 0) store.delete(key);
      else store.set(key, { history, windowSec });
    },
    // eslint-disable-next-line @typescript-eslint/require-await -- Preserve the asynchronous interface and rejection semantics.
    async snapshot(key) {
      const entry = store.get(key);
      if (!entry) return null;
      const history = prune(key, Date.now() / 1000, entry.windowSec);
      if (history.length === 0) return null;
      return { count: history.length, lastRequestMs: consumptionTime(history[0]) * 1000 };
    },
    async record(key, windowSec) {
      await this.consume(key, Number.MAX_SAFE_INTEGER, windowSec);
    },
  };
}

let injectedTestBackend: RateLimitBackend | undefined;

/** Explicit process-local injection for unit tests. Never call from Worker code. */
export function setRateLimitBackendForTests(
  backend: RateLimitBackend | undefined,
): void {
  injectedTestBackend = backend;
}

const unavailableBackend: RateLimitBackend = {
  // eslint-disable-next-line @typescript-eslint/require-await -- Preserve the asynchronous interface and rejection semantics.
  async consume() {
    // Missing rate limiting must never turn into unlimited access.
    return { allowed: false, retryAfterSec: 60 };
  },
  async release() {},
  // eslint-disable-next-line @typescript-eslint/require-await -- Preserve the asynchronous interface and rejection semantics.
  async snapshot() {
    // 同じ理由でフォールバック経路も飽和したものとして扱う。
    return { count: Number.MAX_SAFE_INTEGER, lastRequestMs: Date.now() };
  },
  async record() {},
};

/**
 * Workers は RATE_LIMITER DO、Node は注入された PostgreSQL バックエンドを使う。
 * どちらも無いときはテスト注入か fail-closed にフォールバックする。
 */
export function rateLimitBackend(env: Bindings): RateLimitBackend {
  if (env.RATE_LIMIT_BACKEND) return env.RATE_LIMIT_BACKEND;
  const ns = env.RATE_LIMITER;
  if (!ns) return injectedTestBackend ?? unavailableBackend;
  const stubFor = (key: string) => ns.get(ns.idFromName(key));
  return {
    async consume(key, limit, windowSec, cost = 1, reservationId) {
      validateRateLimit(limit, windowSec, cost);
      return stubFor(key).consume(limit, windowSec, cost, reservationId);
    },
    async release(key, windowSec, reservationId) {
      await stubFor(key).release(windowSec, reservationId);
    },
    async snapshot(key) {
      return stubFor(key).snapshot();
    },
    async record(key, windowSec) {
      await stubFor(key).record(windowSec);
    },
  };
}

/** Cloudflare / プロキシの転送ヘッダーからクライアント IP を解決する。 */
export function clientIp(c: Context<AppEnv>): string {
  if (c.env.RUNTIME === "node") return c.req.header("X-VideoQ-Client-IP") || "unknown";
  return (
    c.req.header("CF-Connecting-IP")?.trim() ||
    c.req.header("True-Client-IP")?.trim() ||
    c.req.header("X-Forwarded-For")?.split(",")[0]?.trim() ||
    "unknown"
  );
}

/**
 * 複数スコープを順に消費し、最初の超過結果を返す。
 * ident が null または空のチェックはスキップする。
 * `cost` を指定したチェックは、その枠数を 1 回で原子的に消費する。
 */
export async function enforceThrottles(
  env: Bindings,
  checks: ThrottleCheck[],
): Promise<ConsumeResult | null> {
  const backend = rateLimitBackend(env);
  // 途中のスコープで拒否されたら、先に消費した分を返す。全スコープを通った
  // リクエストだけが枠を使うので、拒否された側に課金が残らない。
  const consumed: { key: string; windowSec: number; reservationId: string }[] = [];
  const compensate = async () => {
    for (const prior of consumed) {
      try { await backend.release(prior.key, prior.windowSec, prior.reservationId); }
      catch { console.error(JSON.stringify({ event: 'throttle_compensation_failed' })); }
    }
  };
  try {
    for (const check of checks) {
      const consumption = throttleConsumption(check);
      if (!consumption) continue;
      const { key, cost, windowSec, limit } = consumption;
      const reservationId = crypto.randomUUID();
      const result = await backend.consume(key, limit, windowSec, cost, reservationId);
      if (!result.allowed) { await compensate(); return result; }
      consumed.push({ key, windowSec, reservationId });
    }
  } catch (error) {
    // Only acknowledged successes are refunded. The failing consume may have
    // committed before its response was lost; retain that unknown charge.
    await compensate();
    throw error;
  }
  return null;
}

/** チャット送信に掛けるスコープ。REST とストリームの両経路で共有する。 */
export function chatThrottleChecks(
  c: Context<AppEnv>,
  userId: string | null | undefined,
  shareSlug: string | null | undefined,
): ThrottleCheck[] {
  return chatThrottlePolicy(userId, !!shareSlug, shareSlug === PUBLIC_DEMO_SHARE_SLUG, clientIp(c));
}

/** レート制限超過を共通エラー形式で返す。 */
export function throttledResponse(
  c: Context<AppEnv>,
  result: ConsumeResult,
): Response {
  const message = `Request was throttled. Expected available in ${result.retryAfterSec} seconds.`;
  return c.json(
    { error: { code: "LIMIT_EXCEEDED", message } },
    429,
    { "Retry-After": String(result.retryAfterSec) },
  );
}
