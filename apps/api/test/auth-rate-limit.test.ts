import { beforeEach, describe, expect, it } from "vitest";
import { durableRateLimitStorage } from "../src/lib/auth";
import {
  createMemoryRateLimitBackend,
  setRateLimitBackendForTests,
} from "../src/lib/rate-limit";
import type { Bindings } from "../src/types/bindings";

// RATE_LIMITER を持たない env はテスト注入バックエンドに落ちる。
const ENV = { ENVIRONMENT: "development" } as unknown as Bindings;
const RULE = { window: 60, max: 3 };

beforeEach(() => {
  setRateLimitBackendForTests(createMemoryRateLimitBackend());
});

describe("Better Auth rate limit storage", () => {
  it("窓を超えた時点で拒否し Retry-After を返す", async () => {
    const storage = durableRateLimitStorage(ENV);
    for (let i = 0; i < RULE.max; i++) {
      expect(await storage.consume("1.2.3.4|/sign-in/email", RULE)).toEqual({
        allowed: true,
        retryAfter: null,
      });
    }
    const denied = await storage.consume("1.2.3.4|/sign-in/email", RULE);
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfter).toBeGreaterThanOrEqual(1);
  });

  it("カウンタは isolate ではなく共有バックエンドに載る", async () => {
    // 別リクエストで作り直したインスタンスでも同じキーを共有する。
    const first = durableRateLimitStorage(ENV);
    for (let i = 0; i < RULE.max; i++) {
      await first.consume("1.2.3.4|/sign-up/email", RULE);
    }
    const second = durableRateLimitStorage(ENV);
    expect(
      (await second.consume("1.2.3.4|/sign-up/email", RULE)).allowed,
    ).toBe(false);
  });

  it("IP とパスが違えば独立して数える", async () => {
    const storage = durableRateLimitStorage(ENV);
    for (let i = 0; i < RULE.max; i++) {
      await storage.consume("1.2.3.4|/sign-in/email", RULE);
    }
    expect(
      (await storage.consume("5.6.7.8|/sign-in/email", RULE)).allowed,
    ).toBe(true);
    expect(
      (await storage.consume("1.2.3.4|/forget-password", RULE)).allowed,
    ).toBe(true);
  });

  it("Better Auth 1.7 の原子的 consume 契約だけを公開する", () => {
    const storage = durableRateLimitStorage(ENV);
    expect(Object.keys(storage)).toEqual(["consume"]);
  });

  it("バックエンドが無い環境では fail closed する", async () => {
    setRateLimitBackendForTests(undefined);
    const storage = durableRateLimitStorage(ENV);
    expect((await storage.consume("1.2.3.4|/sign-in/email", RULE)).allowed).toBe(
      false,
    );
    expect(
      (await storage.consume("1.2.3.4|/sign-in/email", RULE)).retryAfter,
    ).toBeGreaterThanOrEqual(1);
  });
});
