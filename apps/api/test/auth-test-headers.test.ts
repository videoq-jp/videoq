import { describe, expect, it, vi } from "vitest";

// createAuth / withDb には到達させない。到達したら「ヘッダが効かなかった」の証拠。
const pool = vi.hoisted(() => ({
  withDb: vi.fn(async () => {
    throw new Error("withDb should not be reached");
  }),
  withClient: vi.fn(),
}));
vi.mock("../src/db/pool", () => pool);
vi.mock("../src/lib/auth", () => ({
  createAuth: vi.fn(),
  authBaseURL: () => "http://localhost",
  oauthResourceAudience: () => "http://localhost/api/mcp",
}));

import { Hono } from "hono";
import { apiKeyMethod, requireAuth, sessionMethod } from "../src/middleware/auth";
import type { AppEnv } from "../src/types/bindings";
import { TEST_USER_ID } from "./helpers/auth";

const ENV = { ENVIRONMENT: "development" } as unknown as AppEnv["Bindings"];

function appWith(method = sessionMethod) {
  const app = new Hono<AppEnv>();
  app.get("/who", requireAuth(method), (c) => c.json({ userId: c.var.userId }));
  return app;
}

describe("テスト用認証ヘッダの受付条件", () => {
  it("ローカルホスト宛なら開発環境で受け付ける", async () => {
    const res = await appWith().request(
      "http://localhost/who",
      { headers: { "X-VideoQ-Test-User-Id": TEST_USER_ID } },
      ENV,
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ userId: TEST_USER_ID });
  });

  it("ENVIRONMENT が development でも、公開ホスト宛なら受け付けない", async () => {
    // `--env production` を付け忘れた deploy を想定。なりすましを許さない。
    for (const host of [
      "https://videoq-api-dev.example.workers.dev",
      "https://videoq.jp",
    ]) {
      const res = await appWith().request(
        `${host}/who`,
        { headers: { "X-VideoQ-Test-User-Id": TEST_USER_ID } },
        ENV,
      );
      expect(res.status).not.toBe(200);
    }
  });

  it("本番環境ではローカルホスト宛でも受け付けない", async () => {
    const res = await appWith().request(
      "http://localhost/who",
      { headers: { "X-VideoQ-Test-User-Id": TEST_USER_ID } },
      { ENVIRONMENT: "production" },
    );

    expect(res.status).not.toBe(200);
  });

  it("API key 経路でも同じ条件が効く", async () => {
    const headers = {
      "X-API-Key": "vq_abcdefghijklmnop",
      "X-VideoQ-Test-User-Id": TEST_USER_ID,
    };

    const local = await appWith(apiKeyMethod).request(
      "http://localhost/who",
      { headers },
      ENV,
    );
    expect(local.status).toBe(200);

    const remote = await appWith(apiKeyMethod).request(
      "https://videoq.jp/who",
      { headers },
      ENV,
    );
    expect(remote.status).not.toBe(200);
  });
});
