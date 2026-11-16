import { describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import type { Bindings } from "../src/types/bindings";
const base = { ENVIRONMENT: "test", CORS_ALLOW_ORIGIN: "https://app.example" } as Bindings;
describe("migration traffic pause", () => {
  it.each(["paused", "", "false", "RUNNING", "typo"])("fails closed for %j before application work", async state => {
    const app = createApp(), env = { ...base, MIGRATION_TRAFFIC_STATE: state };
    for (const [method, path] of [["POST", "/api/auth/sign-in/email"], ["GET", "/api/auth/callback/google?code=synthetic"], ["POST", "/internal/worker/jobs/claim"], ["POST", "/api/trpc/chat.ask"], ["POST", "/api/billing/webhook"], ["GET", "/ready"], ["GET", "/unknown"]]) {
      const response = await app.request(path, { method }, env);
      expect(response.status).toBe(503);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("retry-after")).toBe("60");
      expect((await response.json()).error.code).toBe("MIGRATION_PAUSED");
    }
    expect((await app.request("/health", {}, env)).status).toBe(200);
  });
  it.each([undefined, "running"])("preserves ordinary dispatch for %j", async state => {
    expect((await createApp().request("/unknown", {}, { ...base, MIGRATION_TRAFFIC_STATE: state })).status).toBe(404);
  });
});
