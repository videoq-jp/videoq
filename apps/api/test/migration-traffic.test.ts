import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
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

// Exercise the operator verifier against the actual Hono middleware, not a
// hand-written copy of its status/body contract. No DB/credential is supplied.
it("operator pause proof accepts the actual Hono pre-auth pause responses", async () => {
  const { verifyProductionTraffic } = createRequire(import.meta.url)("../../../.github/scripts/cutover-owned-api-traffic.cjs");
  const app = createApp();
  const result = await verifyProductionTraffic(true, (url: string, options: RequestInit) =>
    app.request(url, options, { ...base, MIGRATION_TRAFFIC_STATE: "paused" }));
  expect(result).toEqual({ applicationPauseVerified: true, inFlightDrainProven: false });
});
