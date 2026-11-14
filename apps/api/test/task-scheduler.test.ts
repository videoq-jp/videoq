import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ARM_FLOOR_MS,
  armMaintenance,
  chooseWakeup,
  IDLE_BACKOFF_BASE_MS,
  IDLE_BACKOFF_CAP_MS,
  idleBackoffMs,
  nextIdleStrikes,
  refreshMaintenanceSchedule,
} from "../src/lib/task-scheduler";
import type { Bindings } from "../src/types/bindings";

function envWith(stub: { armAt?: unknown; reschedule?: unknown }) {
  const getByName = vi.fn(() => stub);
  return {
    env: { TASK_SCHEDULER: { getByName } } as unknown as Bindings,
    getByName,
  };
}

let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  errorSpy.mockRestore();
});

describe("idleBackoffMs", () => {
  it("空振りしていなければ最小猶予のまま前倒しを妨げない", () => {
    expect(idleBackoffMs(0)).toBe(ARM_FLOOR_MS);
    expect(idleBackoffMs(-1)).toBe(ARM_FLOOR_MS);
  });

  it("空振りが続くほど間隔を倍にする", () => {
    expect(idleBackoffMs(1)).toBe(IDLE_BACKOFF_BASE_MS);
    expect(idleBackoffMs(2)).toBe(IDLE_BACKOFF_BASE_MS * 2);
    expect(idleBackoffMs(3)).toBe(IDLE_BACKOFF_BASE_MS * 4);
  });

  it("上限を超えて広がらない", () => {
    expect(idleBackoffMs(50)).toBe(IDLE_BACKOFF_CAP_MS);
    expect(idleBackoffMs(1000)).toBe(IDLE_BACKOFF_CAP_MS);
  });
});

describe("nextIdleStrikes", () => {
  it("前進した回はリセットする", () => {
    expect(nextIdleStrikes({ progressed: true, overdue: true, previous: 7 })).toBe(0);
  });

  it("未来の期限を待っているだけの回は数えない", () => {
    // ここを数えると、バックオフが正当な起床時刻まで後ろへ倒してしまう。
    expect(nextIdleStrikes({ progressed: false, overdue: false, previous: 7 })).toBe(0);
  });

  it("期限が来ているのに前進できなかった回だけ数える", () => {
    expect(nextIdleStrikes({ progressed: false, overdue: true, previous: 0 })).toBe(1);
    expect(nextIdleStrikes({ progressed: false, overdue: true, previous: 3 })).toBe(4);
  });
});

describe("chooseWakeup", () => {
  const now = 1_700_000_000_000;

  it("対象が無ければ張り直さない", () => {
    expect(
      chooseWakeup({
        nextAt: null,
        nextFutureAt: null,
        pendingAlarm: null,
        strikes: 0,
        now,
      }),
    ).toBeNull();
  });

  it("対象が無くても、並行して予約された起床は残す", () => {
    // DB問い合わせ中に届いた armAt を、古いスナップショットで消してはならない。
    expect(
      chooseWakeup({
        nextAt: null,
        nextFutureAt: null,
        pendingAlarm: now + 60_000,
        strikes: 0,
        now,
      }),
    ).toBeNull();
  });

  it("未来の期限はバックオフに関係なくそのまま使う", () => {
    expect(
      chooseWakeup({
        nextAt: now + 120_000,
        nextFutureAt: now + 120_000,
        pendingAlarm: null,
        strikes: 6,
        now,
      }),
    ).toBe(now + 120_000);
  });

  it.each([null, now + 10 * 60_000])(
    "期限切れ対象の空振りが続いても別タスクのリース満了を遅らせない（予約: %s）",
    (pendingAlarm) => {
      const strikes = nextIdleStrikes({ progressed: false, overdue: true, previous: 6 });
      const leaseExpiresAt = now + 4 * 60_000;

      expect(
        chooseWakeup({
          nextAt: now - 3_600_000,
          nextFutureAt: leaseExpiresAt,
          pendingAlarm,
          strikes,
          now,
        }),
      ).toBe(leaseExpiresAt);
    },
  );

  it("未来の期限よりバックオフ明けが早ければ回復を先送りしない", () => {
    expect(
      chooseWakeup({
        nextAt: now - 1,
        nextFutureAt: now + 90 * 60_000,
        pendingAlarm: null,
        strikes: 2,
        now,
      }),
    ).toBe(now + 2 * 60_000);
  });

  it.each([now - 1, now, now + ARM_FLOOR_MS / 2])(
    "DB 問い合わせ中に迫った未来の期限は最小猶予で起こす（期限: %s）",
    (nextFutureAt) => {
      expect(
        chooseWakeup({
          nextAt: now - 3_600_000,
          nextFutureAt,
          pendingAlarm: null,
          strikes: 7,
          now,
        }),
      ).toBe(now + ARM_FLOOR_MS);
    },
  );

  it("期限切れのまま前進できないときだけ間隔を広げる", () => {
    expect(
      chooseWakeup({
        nextAt: now - 1,
        nextFutureAt: null,
        pendingAlarm: null,
        strikes: 0,
        now,
      }),
    ).toBe(now + ARM_FLOOR_MS);
    expect(
      chooseWakeup({
        nextAt: now - 1,
        nextFutureAt: null,
        pendingAlarm: null,
        strikes: 2,
        now,
      }),
    ).toBe(now + IDLE_BACKOFF_BASE_MS * 2);
  });

  it("既存アラームの方が早ければ動かさない", () => {
    expect(
      chooseWakeup({
        nextAt: now + 600_000,
        nextFutureAt: now + 600_000,
        pendingAlarm: now + 60_000,
        strikes: 0,
        now,
      }),
    ).toBeNull();
  });

  it("既存アラームより早い期限なら前倒しする", () => {
    expect(
      chooseWakeup({
        nextAt: now + 30_000,
        nextFutureAt: now + 30_000,
        pendingAlarm: now + 600_000,
        strikes: 0,
        now,
      }),
    ).toBe(now + 30_000);
  });

  it("バックオフ中でも既存の早いアラームを後ろへ倒さない", () => {
    expect(
      chooseWakeup({
        nextAt: now - 1,
        nextFutureAt: now + 4 * 60_000,
        pendingAlarm: now + 5_000,
        strikes: 8,
        now,
      }),
    ).toBeNull();
  });
});

describe("armMaintenance", () => {
  it.each(["armAt", "reschedule"] as const)("redacts Durable Object diagnostics from %s failures", async method => {
    const canary = "synthetic-private-DO-SQL-token";
    const { env } = envWith({ [method]: vi.fn().mockRejectedValueOnce(new Error(canary)) });
    if (method === "armAt") await armMaintenance(env, Date.now());
    else await refreshMaintenanceSchedule(env, false);
    expect(errorSpy).toHaveBeenCalledOnce();
    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain(canary);
  });

  it("単一インスタンスへ起床時刻を渡す", async () => {
    const armAt = vi.fn().mockResolvedValue(undefined);
    const { env, getByName } = envWith({ armAt });

    await armMaintenance(env, 1_700_000_000_000);

    expect(getByName).toHaveBeenCalledWith("default");
    expect(armAt).toHaveBeenCalledWith(1_700_000_000_000);
  });

  it("起床予約の失敗で業務処理を巻き戻さない", async () => {
    const armAt = vi.fn().mockRejectedValue(new Error("durable object unavailable"));
    const { env } = envWith({ armAt });

    await expect(armMaintenance(env, Date.now())).resolves.toBeUndefined();
    expect(errorSpy).toHaveBeenCalledOnce();
    expect(String(errorSpy.mock.calls[0][0])).toContain("maintenance_arm_failed");
  });

  it("バインディングが無い環境でも落ちない", async () => {
    await expect(armMaintenance({} as Bindings, Date.now())).resolves.toBeUndefined();
    expect(errorSpy).toHaveBeenCalledOnce();
  });
});

describe("refreshMaintenanceSchedule", () => {
  it("回復が進んだかどうかをそのまま渡す", async () => {
    const reschedule = vi.fn().mockResolvedValue(undefined);
    const { env } = envWith({ reschedule });

    await refreshMaintenanceSchedule(env, true);

    expect(reschedule).toHaveBeenCalledWith(true);
  });

  it("張り直しの失敗を日次cronの失敗にしない", async () => {
    const reschedule = vi.fn().mockRejectedValue(new Error("db unavailable"));
    const { env } = envWith({ reschedule });

    await expect(refreshMaintenanceSchedule(env, false)).resolves.toBeUndefined();
    expect(String(errorSpy.mock.calls[0][0])).toContain("maintenance_reschedule_failed");
  });
});
