import { beforeEach, describe, expect, it, vi } from "vitest";

const verifyVideoqApiKey = vi.hoisted(() => vi.fn());
const getSession = vi.hoisted(() => vi.fn());
vi.mock("../src/db/pool", () => ({
  withDb: (_env: unknown, fn: (db: object) => unknown) => fn({}),
}));
vi.mock("../src/persistence/postgres/auth", () => ({
  createAuth: () => ({ api: { getSession, verifyVideoqApiKey } }),
}));

import { Hono } from "hono";
import { APIError } from "better-auth/api";
import {
  apiKeyMethod,
  requireAuth,
  requireScope,
  sessionMethod,
} from "../src/middleware/auth";
import type { AppEnv } from "../src/types/bindings";
import { TEST_USER_ID } from "./helpers/auth";

// テスト用ヘッダを使わず、Better Auth APIとの接続とHTTP応答への変換を確認する。
const ENV = { ENVIRONMENT: "production" } as unknown as AppEnv["Bindings"];

function app() {
  const a = new Hono<AppEnv>();
  a.get("/who", requireAuth(apiKeyMethod), (c) => c.json({ userId: c.var.userId }));
  a.all("/scoped", requireAuth(apiKeyMethod), requireScope(), (c) => c.json({ allowed: true }));
  a.get("/session", requireAuth(sessionMethod), (c) =>
    c.json({ userId: c.var.userId, authVia: c.var.authVia }),
  );
  return a;
}

function request() {
  return app().request(
    "https://videoq.jp/who",
    { headers: { "X-API-Key": "vq_abcdefghijklmnop" } },
    ENV,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  verifyVideoqApiKey.mockResolvedValue({ kind: "ok", userId: TEST_USER_ID, via: "apikey", accessLevel: "all" });
  getSession.mockResolvedValue(null);
});

describe("Better Auth session と停止アカウント", () => {
  const sessionRequest = () => app().request("https://videoq.jp/session", {}, ENV);

  it("Cookieキャッシュを使わず、失効状態をDBから確認する", async () => {
    getSession.mockResolvedValue({
      user: { id: TEST_USER_ID, banned: false, isActive: true },
    });

    const res = await sessionRequest();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ userId: TEST_USER_ID, authVia: "session" });
    expect(getSession).toHaveBeenCalledWith(expect.objectContaining({
      query: { disableCookieCache: true },
    }));
  });

  it.each(["UNAUTHORIZED", "FORBIDDEN"] as const)("Better Authの%sを認証拒否として扱う", async (status) => {
    getSession.mockRejectedValueOnce(new APIError(status));
    expect((await sessionRequest()).status).toBe(401);
  });

  it.each([new Error("database unavailable"), new APIError("INTERNAL_SERVER_ERROR")])("サーバー障害を認証拒否に変換しない: %s", async (error) => {
    getSession.mockRejectedValueOnce(error);
    const a = app();
    const onError = vi.fn(() => new Response(null, { status: 500 }));
    a.onError(onError);
    expect((await a.request("https://videoq.jp/session", {}, ENV)).status).toBe(500);
    expect(onError).toHaveBeenCalledWith(error, expect.anything());
  });
});

describe("Better Auth resource plugin integration", () => {
  it("delegates API key verification to the server-only plugin endpoint", async () => {
    const res = await request();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ userId: TEST_USER_ID });
    expect(verifyVideoqApiKey).toHaveBeenCalledWith({ body: { key: "vq_abcdefghijklmnop" } });
  });

  it("maps a refused API key to 401", async () => {
    verifyVideoqApiKey.mockResolvedValue({ kind: "invalid", message: "User is inactive" });
    expect((await request()).status).toBe(401);
  });

  it.each([
    ["all", 200, 200], ["read_only", 200, 403], ["unknown", 403, 403],
  ])("enforces verified access level %s", async (accessLevel, readStatus, writeStatus) => {
    verifyVideoqApiKey.mockResolvedValue({ kind: "ok", userId: TEST_USER_ID, via: "apikey", accessLevel });
    for (const [method, status] of [["GET", readStatus], ["POST", writeStatus]] as const) {
      const response = await app().request("https://videoq.jp/scoped", {
        method, headers: { "X-API-Key": "vq_abcdefghijklmnop" },
      }, ENV);
      expect(response.status).toBe(status);
    }
  });
});
