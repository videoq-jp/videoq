import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { expect, it } from "vitest";
import type { Bindings } from "../../src/types/bindings";
it("preserves scheduler wakeup while paused without opening the business database", async () => {
  const stub = env.TASK_SCHEDULER.getByName("migration-pause-scheduler");
  await runInDurableObject(stub, async (instance, state) => {
    const object = instance as unknown as { env: Bindings; alarm(): Promise<void>; reschedule(progressed: boolean): Promise<void> };
    const previous = object.env;
    object.env = { MIGRATION_TRAFFIC_STATE: "paused" } as Bindings;
    try {
      await object.alarm();
      expect(await state.storage.getAlarm()).toBeGreaterThan(Date.now());
      await state.storage.deleteAlarm();
      await object.reschedule(false);
      expect(await state.storage.getAlarm()).toBeGreaterThan(Date.now());
    } finally { object.env = previous; await state.storage.deleteAlarm(); }
  });
});

it("blocks the chat Durable Object before loading or dispatching the application", async () => {
  const stub = env.CHAT_EXECUTION.getByName("migration-pause-chat");
  await runInDurableObject(stub, async instance => {
    const object = instance as unknown as { env: Bindings; fetch(request: Request): Promise<Response> };
    const previous = object.env;
    object.env = { MIGRATION_TRAFFIC_STATE: "paused" } as Bindings;
    try {
      const response = await object.fetch(new Request("https://app.example/api/trpc/chat.ask", { method: "POST" }));
      expect(response.status).toBe(503);
      expect((await response.json<{ error: { code: string } }>()).error.code).toBe("MIGRATION_PAUSED");
    } finally { object.env = previous; }
  });
});
