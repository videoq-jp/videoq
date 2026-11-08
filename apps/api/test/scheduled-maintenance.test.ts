import { beforeEach, describe, expect, it, vi } from "vitest";

const tasks = vi.hoisted(() => ({ processExternalTasks: vi.fn() }));
const uploads = vi.hoisted(() => ({
  reconcileAbandonedUploads: vi.fn(),
  ABANDONED_UPLOAD_MS: 2 * 60 * 60 * 1000,
}));
const repository = vi.hoisted(() => ({
  getExternalTaskHealth: vi.fn(),
  pruneDeliveryHistory: vi.fn(),
  EXTERNAL_TASK_LEASE_MS: 5 * 60 * 1000,
}));
const invitations = vi.hoisted(() => ({ failInvitationsWithoutLiveDelivery: vi.fn() }));
const mcpIdempotency = vi.hoisted(() => ({ pruneMcpIdempotencyRecords: vi.fn() }));
const conversations = vi.hoisted(() => ({ pruneConversations: vi.fn() }));
const audit = vi.hoisted(() => ({ pruneLtiAudit: vi.fn() }));
const lti = vi.hoisted(() => ({ pruneLtiCredentials: vi.fn() }));
const scheduler = vi.hoisted(() => ({ refreshMaintenanceSchedule: vi.fn() }));

vi.mock("../src/lib/external-tasks", () => tasks);
vi.mock("../src/lib/upload-reconcile", () => uploads);
vi.mock("../src/repositories/external-task-repository", () => repository);
vi.mock("../src/repositories/course-invitation-repository", () => invitations);
vi.mock("../src/repositories/mcp-idempotency-repository", () => mcpIdempotency);
vi.mock("../src/lib/task-scheduler", () => scheduler);
vi.mock("../src/features/lti/store", () => lti);
vi.mock("../src/features/lti/audit-retention", () => audit);
vi.mock("../src/repositories/conversation-repository", () => conversations);

import {
  INVITATION_QUEUED_STALE_MS,
  MAINTENANCE_WINDOWS,
  RETENTION_CRON,
  runMaintenanceSweep,
  runScheduledMaintenance,
} from "../src/lib/scheduled-maintenance";

const env = {} as never;

beforeEach(() => {
  vi.clearAllMocks();
  tasks.processExternalTasks.mockResolvedValue({
    claimed: 0,
    completed: 0,
    failed: 0,
    dead: 0,
  });
  uploads.reconcileAbandonedUploads.mockResolvedValue({
    scanned: 0,
    released: 0,
    releasedBytes: 0,
    errors: 0,
  });
  repository.getExternalTaskHealth.mockResolvedValue({
    pending: 0,
    dead: 0,
    oldestPendingSeconds: null,
  });
  repository.pruneDeliveryHistory.mockResolvedValue({
    externalTasks: 0,
    jobExecutions: 0,
  });
  invitations.failInvitationsWithoutLiveDelivery.mockResolvedValue({ failed: 0 });
  mcpIdempotency.pruneMcpIdempotencyRecords.mockResolvedValue({ deleted: 0 });
  scheduler.refreshMaintenanceSchedule.mockResolvedValue(undefined);
  conversations.pruneConversations.mockResolvedValue(0);
  lti.pruneLtiCredentials.mockResolvedValue(undefined);
  audit.pruneLtiAudit.mockResolvedValue({ enabled: false, backlog: false });
});

describe("maintenance sweep", () => {
  it("片方が失敗しても全ての回復処理がsettleするまで待つ", async () => {
    tasks.processExternalTasks.mockRejectedValue(new Error("db unavailable"));

    await expect(runMaintenanceSweep(env)).rejects.toBeInstanceOf(AggregateError);

    expect(uploads.reconcileAbandonedUploads).toHaveBeenCalledOnce();
    expect(repository.getExternalTaskHealth).toHaveBeenCalledOnce();
  });

  it("配送タスクが尽きた招待を失敗として回収する", async () => {
    const now = new Date("2026-08-22T09:00:00.000Z");
    invitations.failInvitationsWithoutLiveDelivery.mockResolvedValue({ failed: 2 });

    await runMaintenanceSweep(env, now);

    expect(invitations.failInvitationsWithoutLiveDelivery).toHaveBeenCalledWith(
      env,
      now,
      INVITATION_QUEUED_STALE_MS,
    );
  });

  it("起床は呼び出し側が管理するので保険のアラームを張らない", async () => {
    await runMaintenanceSweep(env);

    expect(tasks.processExternalTasks).toHaveBeenCalledWith(env, {
      limit: 50,
      arm: false,
    });
  });

  it.each([
    ["外部タスクを掴んだ", { externalTasks: { claimed: 1 } }, true],
    ["放棄アップロードを解放した", { abandonedUploads: { released: 1 } }, true],
    ["滞留招待を倒した", { staleInvitations: { failed: 1 } }, true],
    ["何も対象が無かった", {}, false],
  ])("進捗判定: %s", async (_label, overrides, expected) => {
    const patch = overrides as Record<string, Record<string, number>>;
    if (patch.externalTasks) {
      tasks.processExternalTasks.mockResolvedValue({
        claimed: 0,
        completed: 0,
        failed: 0,
        dead: 0,
        ...patch.externalTasks,
      });
    }
    if (patch.abandonedUploads) {
      uploads.reconcileAbandonedUploads.mockResolvedValue({
        scanned: 0,
        released: 0,
        releasedBytes: 0,
        errors: 0,
        ...patch.abandonedUploads,
      });
    }
    if (patch.staleInvitations) {
      invitations.failInvitationsWithoutLiveDelivery.mockResolvedValue(
        patch.staleInvitations,
      );
    }

    await expect(runMaintenanceSweep(env)).resolves.toEqual({ progressed: expected });
  });
});

describe("maintenance windows", () => {
  it("回復側の閾値と起床時刻の計算に同じ値を使う", () => {
    expect(MAINTENANCE_WINDOWS).toEqual({
      leaseMs: repository.EXTERNAL_TASK_LEASE_MS,
      abandonedUploadMs: uploads.ABANDONED_UPLOAD_MS,
      staleInvitationMs: INVITATION_QUEUED_STALE_MS,
    });
  });
});

describe("scheduled maintenance", () => {
  it("日次cronは掃除と回復のセーフティネットを両方走らせる", async () => {
    await runScheduledMaintenance(env, RETENTION_CRON);

    expect(repository.pruneDeliveryHistory).toHaveBeenCalledOnce();
    expect(mcpIdempotency.pruneMcpIdempotencyRecords).toHaveBeenCalledOnce();
    expect(audit.pruneLtiAudit).toHaveBeenCalledOnce();
    expect(tasks.processExternalTasks).toHaveBeenCalledOnce();
    expect(uploads.reconcileAbandonedUploads).toHaveBeenCalledOnce();
    expect(invitations.failInvitationsWithoutLiveDelivery).toHaveBeenCalledOnce();
  });

  it("監査記録の保存期限処理にも同じ時計を渡す", async () => {
    const now = new Date("2026-11-06T00:00:00Z");
    await runScheduledMaintenance(env, RETENTION_CRON, now);
    expect(audit.pruneLtiAudit).toHaveBeenCalledWith(env, now);
  });

  it("監査記録の削除に失敗しても回復と次回アラームを維持する", async () => {
    audit.pruneLtiAudit.mockRejectedValue(new Error("audit cleanup unavailable"));
    await expect(runScheduledMaintenance(env, RETENTION_CRON)).rejects.toBeInstanceOf(AggregateError);
    expect(tasks.processExternalTasks).toHaveBeenCalledOnce();
    expect(scheduler.refreshMaintenanceSchedule).toHaveBeenCalledWith(env, false);
  });

  it("回復の結果をDOに渡して次回の起床時刻を張り直させる", async () => {
    invitations.failInvitationsWithoutLiveDelivery.mockResolvedValue({ failed: 1 });

    await runScheduledMaintenance(env, RETENTION_CRON);

    expect(scheduler.refreshMaintenanceSchedule).toHaveBeenCalledWith(env, true);
  });

  it("掃除が失敗しても回復とアラーム再設定は走る", async () => {
    repository.pruneDeliveryHistory.mockRejectedValue(new Error("db unavailable"));

    await expect(
      runScheduledMaintenance(env, RETENTION_CRON),
    ).rejects.toBeInstanceOf(AggregateError);

    expect(tasks.processExternalTasks).toHaveBeenCalledOnce();
    expect(scheduler.refreshMaintenanceSchedule).toHaveBeenCalledWith(env, false);
  });

  it("回復が失敗してもアラームは張り直す", async () => {
    tasks.processExternalTasks.mockRejectedValue(new Error("db unavailable"));

    await expect(
      runScheduledMaintenance(env, RETENTION_CRON),
    ).rejects.toBeInstanceOf(AggregateError);

    expect(repository.pruneDeliveryHistory).toHaveBeenCalledOnce();
    expect(scheduler.refreshMaintenanceSchedule).toHaveBeenCalledWith(env, false);
  });

  it("撤廃した5分cronを含め、未知のcronでは何も実行しない", async () => {
    for (const cron of ["*/5 * * * *", "0 * * * *", "0 0 * * *"]) {
      await expect(runScheduledMaintenance(env, cron)).rejects.toThrow(
        "Unknown scheduled maintenance cron",
      );
    }

    expect(tasks.processExternalTasks).not.toHaveBeenCalled();
    expect(uploads.reconcileAbandonedUploads).not.toHaveBeenCalled();
    expect(repository.pruneDeliveryHistory).not.toHaveBeenCalled();
    expect(scheduler.refreshMaintenanceSchedule).not.toHaveBeenCalled();
  });
});
