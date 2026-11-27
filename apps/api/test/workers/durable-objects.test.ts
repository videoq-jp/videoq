import { env } from "cloudflare:workers";
import {
  evictDurableObject,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("RateLimiter Durable Object", () => {
  it("atomically enforces cost and keeps state across eviction", async () => {
    const stub = env.RATE_LIMITER.getByName("runtime-rate-limit");

    await expect(stub.consume(2, 60, 1, "reservation")).resolves.toEqual({
      allowed: true,
      retryAfterSec: 0,
    });
    await expect(stub.consume(2, 60, 2)).resolves.toMatchObject({
      allowed: false,
    });

    await evictDurableObject(stub);
    await expect(stub.snapshot()).resolves.toMatchObject({ count: 1 });

    await stub.release(60, "reservation");
    await expect(stub.snapshot()).resolves.toBeNull();
  });

  it("schedules and executes its cleanup alarm", async () => {
    const stub = env.RATE_LIMITER.getByName("runtime-rate-limit-alarm");
    await stub.consume(2, 60);

    await runInDurableObject(stub, async (_instance, state) => {
      await expect(state.storage.getAlarm()).resolves.toBeTypeOf("number");
    });
    await expect(runDurableObjectAlarm(stub)).resolves.toBe(true);
    await expect(stub.snapshot()).resolves.toMatchObject({ count: 1 });
  });
});

describe("TaskScheduler Durable Object", () => {
  const alarmOf = (stub: DurableObjectStub) =>
    runInDurableObject(stub, (_instance, state) => state.storage.getAlarm());

  it("keeps the earliest requested wakeup when armed repeatedly", async () => {
    const stub = env.TASK_SCHEDULER.getByName("runtime-task-scheduler-arm");
    const soon = Date.now() + 60_000;

    await stub.armAt(soon);
    await expect(alarmOf(stub)).resolves.toBe(soon);

    // 後ろの時刻は無視する。張り直しで起床が先送りされると回復が遅れる。
    await stub.armAt(soon + 600_000);
    await expect(alarmOf(stub)).resolves.toBe(soon);

    // 前倒しは通す。バックオフ明けを正確に拾うために必要。
    await stub.armAt(soon - 30_000);
    await expect(alarmOf(stub)).resolves.toBe(soon - 30_000);
  });

  it("clamps past timestamps so a stale request cannot spin the alarm", async () => {
    const stub = env.TASK_SCHEDULER.getByName("runtime-task-scheduler-floor");

    await stub.armAt(Date.now() - 600_000);

    const alarm = await alarmOf(stub);
    expect(alarm).toBeTypeOf("number");
    expect(alarm as number).toBeGreaterThan(Date.now());
  });

  it("survives eviction with its pending wakeup intact", async () => {
    const stub = env.TASK_SCHEDULER.getByName("runtime-task-scheduler-evict");
    const at = Date.now() + 3_600_000;

    await stub.armAt(at);
    await evictDurableObject(stub);

    await expect(alarmOf(stub)).resolves.toBe(at);
  });
});
