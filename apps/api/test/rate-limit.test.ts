import { URL } from "node:url";
import { readFileSync } from "node:fs";
import type { Context } from "hono";
import { describe, it, expect, beforeEach } from "vitest";
import { PUBLIC_DEMO_SHARE_SLUG } from "@videoq/trpc/public-demo";
import {
  chatThrottleChecks,
  createMemoryRateLimitBackend,
  enforceThrottles,
  pruneExpiredHistory,
  setRateLimitBackendForTests,
  THROTTLE_RATES,
} from "../src/lib/rate-limit";
import type { AppEnv, Bindings } from "../src/types/bindings";

const ENV = {
  ENVIRONMENT: "development",
  AUTH_JWT_SECRET: "x",
  HYPERDRIVE: { connectionString: "postgres://fake/db" },
} as unknown as Bindings;

beforeEach(() => {
  setRateLimitBackendForTests(createMemoryRateLimitBackend());
});

describe("chatThrottleChecks", () => {
  const context = {
    env: {},
    req: { header: (name: string) => (name === "CF-Connecting-IP" ? "203.0.113.9" : undefined) },
  } as unknown as Context<AppEnv>;

  it("公開デモだけ狭い IP 枠を消費し、上限で止める", async () => {
    const checks = chatThrottleChecks(context, null, PUBLIC_DEMO_SHARE_SLUG);
    for (let i = 0; i < THROTTLE_RATES.chat_public_demo_ip.limit; i++) {
      expect(await enforceThrottles(ENV, checks)).toBeNull();
    }
    expect((await enforceThrottles(ENV, checks))?.allowed).toBe(false);
  });

  it("通常の共有リンクには公開デモの枠を掛けない", () => {
    const checks = chatThrottleChecks(context, null, "someone-elses-course");
    expect(checks.find(check => check.scope === "chat_share_token_ip")?.ident).toBe("203.0.113.9");
    expect(checks.find(check => check.scope === "chat_public_demo_ip")?.ident).toBeNull();
  });

  it("登録スクリプトが使う講座のスラッグと一致する", () => {
    const course = JSON.parse(readFileSync(new URL("../../demo-video/content/course.json", import.meta.url), "utf8")) as { slug: string };
    expect(course.slug).toBe(PUBLIC_DEMO_SHARE_SLUG);
  });
});

describe("pruneExpiredHistory", () => {
  it("期限切れだけを末尾から除去する", () => {
    expect(pruneExpiredHistory([100, 90, 80, 70], 101, 20)).toEqual([
      100,
      90,
    ]);
  });
});

describe("enforceThrottles (memory backend)", () => {
  it("allows under the limit and blocks at the limit", async () => {
    const { limit } = THROTTLE_RATES.login_ip;
    for (let i = 0; i < limit; i++) {
      const r = await enforceThrottles(ENV, [
        { scope: "login_ip", ident: "1.2.3.4" },
      ]);
      expect(r).toBeNull();
    }
    const denied = await enforceThrottles(ENV, [
      { scope: "login_ip", ident: "1.2.3.4" },
    ]);
    expect(denied).not.toBeNull();
    expect(denied!.allowed).toBe(false);
    expect(denied!.retryAfterSec).toBeGreaterThanOrEqual(1);
  });

  it("fails closed when no backend is configured", async () => {
    setRateLimitBackendForTests(undefined);
    const denied = await enforceThrottles(
      { ...ENV, RATE_LIMITER: undefined },
      [{ scope: "login_ip", ident: "1.2.3.4" }],
    );
    expect(denied).toEqual({ allowed: false, retryAfterSec: 60 });
  });

  it("isolates counters by scope and ident", async () => {
    const { limit } = THROTTLE_RATES.login_ip;
    for (let i = 0; i < limit; i++) {
      await enforceThrottles(ENV, [{ scope: "login_ip", ident: "a" }]);
    }
    // 別 IP はまだ通る
    expect(
      await enforceThrottles(ENV, [{ scope: "login_ip", ident: "b" }]),
    ).toBeNull();
    // 別スコープも通る
    expect(
      await enforceThrottles(ENV, [{ scope: "signup_ip", ident: "a" }]),
    ).toBeNull();
  });

  it("cost 分をまとめて消費し、枠に収まらなければ 1 件も記録しない", async () => {
    const { limit } = THROTTLE_RATES.course_invitation_user;
    const invite = (cost: number) =>
      enforceThrottles(ENV, [
        { scope: "course_invitation_user", ident: "owner", cost },
      ]);

    expect(await invite(limit - 1)).toBeNull();
    // 残り 1 枠しかないので 50 宛先の一括招待は通らない。
    const denied = await invite(50);
    expect(denied).not.toBeNull();
    expect(denied!.allowed).toBe(false);
    // 拒否されたリクエストは枠を消費していないので、1 宛先はまだ通る。
    expect(await invite(1)).toBeNull();
    expect(await invite(1)).not.toBeNull();
  });

  it("宛先数ではなくリクエスト数で数えない", async () => {
    const { limit } = THROTTLE_RATES.course_invitation_course;
    // 50 宛先 × N 回で limit を超えた時点で止まる（リクエスト数は少なくても）。
    const batches = Math.floor(limit / 50);
    for (let i = 0; i < batches; i++) {
      expect(
        await enforceThrottles(ENV, [
          { scope: "course_invitation_course", ident: "7", cost: 50 },
        ]),
      ).toBeNull();
    }
    expect(
      await enforceThrottles(ENV, [
        { scope: "course_invitation_course", ident: "7", cost: 50 },
      ]),
    ).not.toBeNull();
  });

  it("skips checks with empty ident", async () => {
    for (let i = 0; i < 10; i++) {
      expect(
        await enforceThrottles(ENV, [
          { scope: "chat_share_token_ip", ident: null },
          { scope: "chat_authenticated", ident: "" },
        ]),
      ).toBeNull();
    }
  });
});
