import { beforeEach, expect, it, vi } from "vitest";
import { createApp } from "../src/app";

const withDb = vi.hoisted(() => vi.fn(async () => { throw new Error("Body must be rejected before database access"); }));
vi.mock("../src/db/pool", () => ({ withDb }));

const MAX_BYTES = 4 * 1024 * 1024;
beforeEach(() => vi.clearAllMocks());

it.each([
  "/api/auth/sign-in/email",
  "/api/trpc/videos.update",
  "/api/mcp",
  "/api/billing/webhook",
])("rejects oversized JSON at %s before authentication or parsing", async path => {
  const response = await createApp().request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Content-Length": String(MAX_BYTES + 1) },
    body: " ".repeat(MAX_BYTES + 1),
  }, { ENVIRONMENT: "production" });
  expect(response.status).toBe(413);
  expect(withDb).not.toHaveBeenCalled();
});

it("limits chunked input without Content-Length before parsing", async () => {
  const body = new ReadableStream<Uint8Array>({ start(controller) {
    controller.enqueue(new Uint8Array(MAX_BYTES));
    controller.enqueue(new Uint8Array([32]));
    controller.close();
  } });
  const request = new Request("https://videoq.test/api/trpc/videos.update", {
    method: "POST", headers: { "Content-Type": "application/json" }, body, duplex: "half",
  } as RequestInit);
  const response = await createApp().fetch(request, { ENVIRONMENT: "production" });
  expect(response.status).toBe(413);
  expect(withDb).not.toHaveBeenCalled();
});
