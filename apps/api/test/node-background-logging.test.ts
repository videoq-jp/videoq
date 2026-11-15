import { describe, expect, it, vi } from "vitest";

const background = vi.hoisted((): { reason: unknown } => ({ reason: undefined }));
vi.mock("../src/app", () => ({
  createApp: () => ({
    fetch: (_request: Request, _env: unknown, context: { waitUntil(promise: Promise<unknown>): void }) => {
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- Exercise arbitrary rejection values from background dependencies.
      context.waitUntil(Promise.reject(background.reason));
      return new Response("committed");
    },
  }),
}));

import { createNodeApp } from "../src/runtime/node-app";

describe("Node asynchronous failure diagnostics", () => {
  it.each(["error", "string"])("drains background work without copying its private diagnostic (%s)", async kind => {
    const canary = "synthetic-private-background-SQL-token";
    background.reason = kind === "error" ? new Error(canary, { cause: new Error(canary) }) : canary;
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const app = createNodeApp({} as never);
      const response = await app.fetch(new Request("https://videoq.example/health"));
      expect(await response.text()).toBe("committed");
      await expect(app.drain()).resolves.toBeUndefined();
      expect(log).toHaveBeenCalledOnce();
      expect(JSON.stringify(log.mock.calls)).toContain("background_task_failed");
      expect(JSON.stringify(log.mock.calls)).not.toContain(canary);
    } finally { log.mockRestore(); }
  });
});
