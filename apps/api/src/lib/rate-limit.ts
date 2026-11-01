import type { Context } from "hono";
import { PUBLIC_DEMO_SHARE_SLUG } from "@videoq/trpc/public-demo";
import type { AppEnv, Bindings } from "../types/bindings";

/**
 * VideoQ API のスコープ別レート制限。
 */
export const THROTTLE_RATES = {
  chat_share_token_ip: { limit: 100, periodSec: 3600 },
  // 公開デモは誰でも開けるので、1 人が所有者の回答枠を使い切れないよう狭くする。
  chat_public_demo_ip: { limit: 10, periodSec: 3600 },
  chat_authenticated: { limit: 300, periodSec: 3600 },
  login_ip: { limit: 5, periodSec: 60 },
  login_username: { limit: 5, periodSec: 60 },
  signup_ip: { limit: 3, periodSec: 3600 },
  signup_email: { limit: 3, periodSec: 3600 },
  password_reset_ip: { limit: 3, periodSec: 3600 },
  password_reset_email: { limit: 3, periodSec: 3600 },
  email_change_user: { limit: 3, periodSec: 3600 },
  email_change_email: { limit: 3, periodSec: 3600 },
  // 招待は「リクエスト数」ではなく「宛先数」で消費する（1 回 50 件 × 10 回で
  // 500 通送れてしまうのを防ぐ）。
  course_invitation_user: { limit: 200, periodSec: 3600 },
  course_invitation_course: { limit: 200, periodSec: 3600 },
  course_invitation_resend: { limit: 3, periodSec: 3600 },
  // トークン式エンドポイントは未認証で叩けるので、IP 単位で総当り・負荷を絞る。
  course_invitation_token_ip: { limit: 60, periodSec: 3600 },
  course_invitation_decision_user: { limit: 30, periodSec: 3600 },
  // 共有スラッグは利用者が決める短い文字列なので推測できる。解決に「失敗した」
  // 試行だけを絞り、正規の共有視聴（Range 連打）には一切かけない。
  share_slug_probe_ip: { limit: 30, periodSec: 3600 },
  // MCP は HTTP 200 内に tool error を返すため、transport の外ではなく
  // tool 実行直前に user 単位で消費する。書き込みは重く副作用もあるので厳しくする。
  mcp_read_user: { limit: 600, periodSec: 3600 },
  mcp_write_user: { limit: 120, periodSec: 3600 },
} as const;

type ThrottleScope = keyof typeof THROTTLE_RATES;

export type ThrottleCheck = {
  scope: ThrottleScope;
  /** キャッシュキーの ident 部分（user id / IP / email 等）。空ならスキップ。 */
  ident: string | null | undefined;
  /** 1 リクエストで消費する枠数。省略時は 1。 */
  cost?: number;
};

export type ConsumeResult = { allowed: boolean; retryAfterSec: number };

type RateLimitSnapshot = { count: number; lastRequestMs: number };

export type RateLimitBackend = {
  consume(
    key: string,
    limit: number,
    windowSec: number,
    cost?: number,
  ): Promise<ConsumeResult>;
  /** 直前の消費 `cost` 件を取り消す（best-effort）。 */
  release(key: string, windowSec: number, cost: number): Promise<void>;
  /** 消費せずに現在の窓を読む。非原子的フォールバック経路専用。 */
  snapshot(key: string): Promise<RateLimitSnapshot | null>;
  /** 上限判定なしで 1 件記録する。非原子的フォールバック経路専用。 */
  record(key: string, windowSec: number): Promise<void>;
};

/** newest-first の履歴から、現在の窓に残る時刻だけを返す。 */
export function pruneExpiredHistory(
  history: readonly number[],
  nowSec: number,
  windowSec: number,
): number[] {
  const active = [...history];
  const cutoff = nowSec - windowSec;
  while (active.length > 0 && active[active.length - 1] <= cutoff) {
    active.pop();
  }
  return active;
}

/** Unit tests must explicitly inject this isolated backend through Bindings. */
export function createMemoryRateLimitBackend(): RateLimitBackend {
  const store = new Map<string, { history: number[]; windowSec: number }>();
  const prune = (key: string, nowSec: number, windowSec: number): number[] =>
    pruneExpiredHistory(store.get(key)?.history ?? [], nowSec, windowSec);

  return {
    // eslint-disable-next-line @typescript-eslint/require-await -- Preserve the asynchronous interface and rejection semantics.
    async consume(key, limit, windowSec, cost = 1) {
      const now = Date.now() / 1000;
      const history = prune(key, now, windowSec);
      if (history.length + cost > limit) {
        const oldest = history[history.length - 1];
        return {
          allowed: false,
          retryAfterSec:
            oldest === undefined
              ? windowSec
              : Math.max(1, Math.ceil(windowSec - (now - oldest))),
        };
      }
      for (let i = 0; i < cost; i++) history.unshift(now);
      store.set(key, { history, windowSec });
      return { allowed: true, retryAfterSec: 0 };
    },
    // eslint-disable-next-line @typescript-eslint/require-await -- Preserve the asynchronous interface and rejection semantics.
    async release(key, windowSec, cost) {
      const history = prune(key, Date.now() / 1000, windowSec);
      history.splice(0, Math.min(cost, history.length));
      if (history.length === 0) store.delete(key);
      else store.set(key, { history, windowSec });
    },
    // eslint-disable-next-line @typescript-eslint/require-await -- Preserve the asynchronous interface and rejection semantics.
    async snapshot(key) {
      const entry = store.get(key);
      if (!entry) return null;
      const history = prune(key, Date.now() / 1000, entry.windowSec);
      if (history.length === 0) return null;
      return { count: history.length, lastRequestMs: history[0] * 1000 };
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
    async consume(key, limit, windowSec, cost = 1) {
      return stubFor(key).consume(limit, windowSec, cost);
    },
    async release(key, windowSec, cost) {
      await stubFor(key).release(windowSec, cost);
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
  const consumed: { key: string; windowSec: number; cost: number }[] = [];
  for (const check of checks) {
    if (check.ident === null || check.ident === undefined || check.ident === "") {
      continue;
    }
    const rate = THROTTLE_RATES[check.scope];
    const key = `throttle_${check.scope}_${check.ident}`;
    const cost = Math.max(1, Math.trunc(check.cost ?? 1));
    const result = await backend.consume(key, rate.limit, rate.periodSec, cost);
    if (!result.allowed) {
      for (const prior of consumed) {
        // 補償に失敗しても、返せなかった枠が残るだけで安全側。
        await backend
          .release(prior.key, prior.windowSec, prior.cost)
          .catch(() => {});
      }
      return result;
    }
    consumed.push({ key, windowSec: rate.periodSec, cost });
  }
  return null;
}

/** チャット送信に掛けるスコープ。REST とストリームの両経路で共有する。 */
export function chatThrottleChecks(
  c: Context<AppEnv>,
  userId: string | null | undefined,
  shareSlug: string | null | undefined,
): ThrottleCheck[] {
  return [
    { scope: "chat_authenticated", ident: userId },
    { scope: "chat_share_token_ip", ident: shareSlug ? clientIp(c) : null },
    { scope: "chat_public_demo_ip", ident: shareSlug === PUBLIC_DEMO_SHARE_SLUG ? clientIp(c) : null },
  ];
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
