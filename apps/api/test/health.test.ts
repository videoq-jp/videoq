import { describe, it, expect } from "vitest";
import { createApp } from "../src/app";

// バインディングに触れないルート（/health）と共通封筒・requestId の単体テスト。
// DB/Hyperdrive を伴う /ready やプロキシは wrangler dev / 統合テストで検証する。
const ENV = {
  ENVIRONMENT: "test",
  CORS_ALLOW_ORIGIN: "http://localhost:5173",
} as unknown as Parameters<ReturnType<typeof createApp>["request"]>[2];

describe("health", () => {
  it("GET /health returns new contract envelope", async () => {
    const app = createApp();
    const res = await app.request("/health", {}, ENV);
    expect(res.status).toBe(200);
    const body = (await res.json<{
      data: { status: string; env: string };
    }>());
    expect(body.data.status).toBe("ok");
    expect(body.data.env).toBe("test");
    expect(res.headers.get("X-Request-Id")).toMatch(/[0-9a-f-]{36}/);
  });
});
