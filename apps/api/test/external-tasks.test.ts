import { beforeEach, describe, expect, it, vi } from "vitest";

const repository = vi.hoisted(() => ({
  claimExternalTasks: vi.fn(),
  completeExternalTask: vi.fn(),
  completeStorageCleanupTask: vi.fn(),
  failExternalTask: vi.fn(),
}));
const sqs = vi.hoisted(() => ({ sendSqsMessage: vi.fn() }));
const media = vi.hoisted(() => ({ deleteR2Object: vi.fn(), abortR2MultipartUpload: vi.fn(), deleteVisualChunks: vi.fn() }));
const billing = vi.hoisted(() => ({ deleteAccountBilling: vi.fn() }));

vi.mock("../src/repositories/external-task-repository", () => repository);
vi.mock("../src/lib/sqs", () => sqs);
vi.mock("../src/integrations/media", () => media);
vi.mock("../src/features/billing/account-deletion", () => billing);

import {
  processExternalTaskById,
  processExternalTasks,
} from "../src/lib/external-tasks";

const env = {} as never;

beforeEach(() => {
  vi.resetAllMocks();
  repository.claimExternalTasks.mockResolvedValue([]);
  repository.completeExternalTask.mockResolvedValue(undefined);
  repository.completeStorageCleanupTask.mockResolvedValue(undefined);
  repository.failExternalTask.mockResolvedValue({ dead: false, leaseLost: false });
  media.deleteR2Object.mockResolvedValue(undefined);
  billing.deleteAccountBilling.mockResolvedValue(undefined);
});

describe("external task processor", () => {
  it.each(["error", "string"])("redacts provider diagnostics from persisted failures and logs (%s)", async kind => {
    const canary = "synthetic-private-provider-token-and-request";
    const task = { id: 77, attempt: 1, kind: "sqs_job", payload: { message: {} } };
    repository.claimExternalTasks.mockResolvedValueOnce([task]);
    sqs.sendSqsMessage.mockRejectedValueOnce(kind === "error" ? new Error(canary) : canary);
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(processExternalTaskById(env, task.id)).resolves.toBe(false);
      expect(repository.failExternalTask).toHaveBeenCalledOnce();
      expect(repository.failExternalTask.mock.calls[0][2]).not.toContain(canary);
      expect(JSON.stringify(log.mock.calls)).not.toContain(canary);
    } finally { log.mockRestore(); }
  });

  it("redacts dispatch bookkeeping failures without rejecting committed work", async () => {
    const canary = "synthetic-private-claim-SQL-token";
    repository.claimExternalTasks.mockRejectedValueOnce(new Error(canary));
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(processExternalTaskById(env, 77)).resolves.toBe(false);
      expect(log).toHaveBeenCalled();
      expect(JSON.stringify(log.mock.calls)).not.toContain(canary);
    } finally { log.mockRestore(); }
  });

  it("acknowledges retired evaluation jobs without sending them to SQS", async () => {
    const task = { id: 1, attempt: 1, kind: "sqs_job", payload: {
      message: { type: "evaluate_chat_log", job_id: "retired", payload: { chat_log_id: 42 } },
    } };
    repository.claimExternalTasks.mockResolvedValueOnce([task]);
    await expect(processExternalTaskById(env, 1)).resolves.toBe(true);
    expect(repository.completeExternalTask).toHaveBeenCalledWith(env, task);
    expect(sqs.sendSqsMessage).not.toHaveBeenCalled();
    expect(repository.failExternalTask).not.toHaveBeenCalled();
  });

  it("leaves a persisted task for recovery if immediate claiming fails", async () => {
    repository.claimExternalTasks.mockRejectedValueOnce(new Error("Database unavailable"));

    await expect(processExternalTaskById(env, 1)).resolves.toBe(false);
    expect(sqs.sendSqsMessage).not.toHaveBeenCalled();
    expect(repository.completeExternalTask).not.toHaveBeenCalled();
  });

  it("does not reject committed work if recording a delivery failure also fails", async () => {
    repository.claimExternalTasks.mockResolvedValueOnce([
      { id: 1, attempt: 1, kind: "sqs_job", payload: { message: {} } },
    ]);
    sqs.sendSqsMessage.mockResolvedValue(null);
    repository.failExternalTask.mockRejectedValueOnce(new Error("Database unavailable"));

    await expect(processExternalTaskById(env, 1)).resolves.toBe(false);
    expect(repository.completeExternalTask).not.toHaveBeenCalled();
  });

  it("still propagates recovery sweep failures so the scheduler can retry", async () => {
    repository.claimExternalTasks.mockRejectedValueOnce(new Error("Database unavailable"));

    await expect(processExternalTasks(env, { arm: false })).rejects.toThrow("Database unavailable");
  });

  const deletionTask = {
    id: 99, attempt: 1, kind: "sqs_job",
    payload: { message: { type: "delete_account_data", job_id: "delete-user-1", payload: { user_id: "user-1" } } },
  };

  it("waits for billing cancellation before admitting a data-deletion job", async () => {
    repository.claimExternalTasks.mockResolvedValueOnce([deletionTask]);
    let finish!: () => void;
    billing.deleteAccountBilling.mockReturnValue(new Promise<void>(resolve => { finish = resolve; }));
    sqs.sendSqsMessage.mockResolvedValue("deletion-message");
    const run = processExternalTaskById(env, deletionTask.id);
    await vi.waitFor(() => expect(billing.deleteAccountBilling).toHaveBeenCalledExactlyOnceWith(env, "user-1"));
    expect(sqs.sendSqsMessage).not.toHaveBeenCalled();
    expect(repository.completeExternalTask).not.toHaveBeenCalled();
    finish();
    await expect(run).resolves.toBe(true);
    expect(sqs.sendSqsMessage).toHaveBeenCalledExactlyOnceWith(env, JSON.stringify(deletionTask.payload.message));
  });

  it("retains the deletion job for retry when Stripe cannot stop billing", async () => {
    repository.claimExternalTasks.mockResolvedValueOnce([deletionTask]);
    billing.deleteAccountBilling.mockRejectedValue(new Error("Stripe unavailable"));
    await expect(processExternalTaskById(env, deletionTask.id)).resolves.toBe(false);
    expect(sqs.sendSqsMessage).not.toHaveBeenCalled();
    expect(repository.completeExternalTask).not.toHaveBeenCalled();
    expect(repository.failExternalTask).toHaveBeenCalledWith(env, deletionTask, "EXTERNAL_TASK_EXECUTION_FAILED");
  });

  it("rechecks billing and reuses the job identity when SQS delivery is retried", async () => {
    repository.claimExternalTasks.mockResolvedValueOnce([deletionTask]).mockResolvedValueOnce([{ ...deletionTask, attempt: 2 }]);
    sqs.sendSqsMessage.mockResolvedValueOnce(null).mockResolvedValueOnce("deletion-message");
    await expect(processExternalTaskById(env, deletionTask.id)).resolves.toBe(false);
    await expect(processExternalTaskById(env, deletionTask.id)).resolves.toBe(true);
    expect(billing.deleteAccountBilling).toHaveBeenCalledTimes(2);
    expect(sqs.sendSqsMessage.mock.calls.map(([, body]) => body)).toEqual([
      JSON.stringify(deletionTask.payload.message), JSON.stringify(deletionTask.payload.message),
    ]);
  });

  it("SQS送信成功後にタスクを完了する", async () => {
    repository.claimExternalTasks.mockResolvedValueOnce([
      {
        id: 1,
        attempt: 1,
        kind: "sqs_job",
        payload: {
          message: {
            type: "transcribe_video",
            job_id: "job-1",
            payload: { video_id: 42 },
          },
        },
      },
    ]);
    sqs.sendSqsMessage.mockResolvedValue("message-1");

    await expect(processExternalTaskById(env, 1)).resolves.toBe(true);
    expect(sqs.sendSqsMessage).toHaveBeenCalledWith(
      env,
      JSON.stringify({
        type: "transcribe_video",
        job_id: "job-1",
        payload: { video_id: 42 },
      }),
    );
    expect(repository.completeExternalTask).toHaveBeenCalledWith(env, expect.objectContaining({ id: 1, attempt: 1 }));
    expect(repository.failExternalTask).not.toHaveBeenCalled();
  });

  it("SQS送信失敗を完了扱いにせず再試行可能に戻す", async () => {
    repository.claimExternalTasks.mockResolvedValueOnce([
      {
        id: 2,
        attempt: 3,
        kind: "sqs_job",
        payload: {
          message: {
            type: "index_video_transcript",
            job_id: "job-2",
            payload: { video_id: 42 },
          },
        },
      },
    ]);
    sqs.sendSqsMessage.mockResolvedValue(null);

    await expect(processExternalTaskById(env, 2)).resolves.toBe(false);
    expect(repository.completeExternalTask).not.toHaveBeenCalled();
    expect(repository.failExternalTask).toHaveBeenCalledWith(
      env,
      expect.objectContaining({ id: 2, attempt: 3 }),
      "EXTERNAL_TASK_EXECUTION_FAILED",
    );
  });

  it("R2削除後の容量返却をrepositoryの単一トランザクションへ委譲する", async () => {
    repository.claimExternalTasks.mockResolvedValueOnce([
      {
        id: 3,
        attempt: 2,
        kind: "storage_cleanup",
        payload: {
          file_key: "videos/u/video_1_abc123abc123_4096.mp4",
          user_id: "user-1",
          bytes: 4096,
        },
      },
    ]);

    await expect(processExternalTaskById(env, 3)).resolves.toBe(true);
    expect(media.deleteR2Object).toHaveBeenCalledWith(
      env,
      "videos/u/video_1_abc123abc123_4096.mp4",
    );
    expect(media.deleteR2Object).toHaveBeenCalledWith(
      env, "videos/u/video_1_abc123abc123_4096.mp4.frames-v1.json",
    );
    expect(media.deleteR2Object).toHaveBeenCalledWith(
      env, "videos/u/video_1_abc123abc123_4096.mp4.focus-v1.bin",
    );
    expect(repository.completeStorageCleanupTask).toHaveBeenCalledWith(env, {
      lease: expect.objectContaining({ id: 3, attempt: 2 }),
      userId: "user-1",
      bytes: 4096,
    });
  });

  it("claimできない同時実行者は副作用を実行しない", async () => {
    repository.claimExternalTasks.mockResolvedValue([]);

    await expect(processExternalTasks(env, { limit: 50 })).resolves.toEqual({
      claimed: 0,
      completed: 0,
      failed: 0,
      dead: 0,
    });
    expect(sqs.sendSqsMessage).not.toHaveBeenCalled();
    expect(media.deleteR2Object).not.toHaveBeenCalled();
  });

  it("aborts multipart data before deleting objects and releasing reserved capacity", async () => {
    const task = { id: 9, attempt: 1, kind: "storage_cleanup", payload: {
      file_key: "videos/u/large.mkv", multipart_upload_id: "upload-id", user_id: "u", bytes: 45_160_000_000,
    } };
    repository.claimExternalTasks.mockResolvedValueOnce([task]);
    await expect(processExternalTaskById(env, 9)).resolves.toBe(true);
    expect(media.abortR2MultipartUpload).toHaveBeenCalledExactlyOnceWith(env, "videos/u/large.mkv", "upload-id");
    expect(media.abortR2MultipartUpload.mock.invocationCallOrder[0]).toBeLessThan(media.deleteR2Object.mock.invocationCallOrder[0]);
    expect(repository.completeStorageCleanupTask).toHaveBeenCalledWith(env, { lease: task, userId: "u", bytes: 45_160_000_000 });
  });

  it("keeps cleanup retryable and capacity reserved when multipart abort fails", async () => {
    repository.claimExternalTasks.mockResolvedValueOnce([{ id: 9, attempt: 1, kind: "storage_cleanup", payload: {
      file_key: "videos/u/large.mkv", multipart_upload_id: "upload-id", user_id: "u", bytes: 45_160_000_000,
    } }]);
    media.abortR2MultipartUpload.mockRejectedValueOnce(new Error("R2 unavailable"));
    await expect(processExternalTaskById(env, 9)).resolves.toBe(false);
    expect(media.deleteR2Object).not.toHaveBeenCalled();
    expect(repository.completeStorageCleanupTask).not.toHaveBeenCalled();
    expect(repository.failExternalTask).toHaveBeenCalled();
  });

  it("最大試行回数に達したタスクをdeadとして報告する", async () => {
    repository.claimExternalTasks.mockResolvedValueOnce([
      {
        id: 4,
        attempt: 48,
        kind: "sqs_job",
        payload: {
          message: {
            type: "index_video_transcript",
            job_id: "job-dead",
            payload: { chat_log_id: 9 },
          },
        },
      },
    ]);
    sqs.sendSqsMessage.mockResolvedValue(null);
    repository.failExternalTask.mockResolvedValue({ dead: true, leaseLost: false });

    await expect(processExternalTasks(env, { limit: 50 })).resolves.toEqual({
      claimed: 1,
      completed: 0,
      failed: 1,
      dead: 1,
    });
  });

  it("slow delivery does not pre-claim the next task", async () => {
    const first = { id: 10, attempt: 1, kind: "sqs_job", payload: { message: {} } };
    const second = { ...first, id: 11 };
    repository.claimExternalTasks.mockResolvedValueOnce([first]).mockResolvedValueOnce([second]);
    let finishFirst!: (value: string) => void;
    const delivery = new Promise<string>((resolve) => { finishFirst = resolve; });
    sqs.sendSqsMessage.mockReturnValueOnce(delivery).mockResolvedValue("message-2");

    const run = processExternalTasks(env);
    await vi.waitFor(() => expect(sqs.sendSqsMessage).toHaveBeenCalledTimes(1));
    expect(repository.claimExternalTasks).toHaveBeenCalledTimes(1);
    finishFirst("message-1");
    await expect(run).resolves.toEqual({ claimed: 2, completed: 2, failed: 0, dead: 0 });
    const claims = repository.claimExternalTasks.mock.calls;
    expect(claims.every(([, options]) => options.limit === 1)).toBe(true);
    expect(claims[1][1].excludeTaskIds).toEqual([first.id]);
    expect(claims[2][1].excludeTaskIds).toEqual([first.id, second.id]);
  });

  it("does not count a stale completion as successful delivery", async () => {
    repository.claimExternalTasks.mockResolvedValueOnce([
      { id: 12, attempt: 1, kind: "sqs_job", payload: { message: {} } },
    ]);
    sqs.sendSqsMessage.mockResolvedValue("message-1");
    repository.completeExternalTask.mockRejectedValue(new Error("Lease lost"));
    repository.failExternalTask.mockResolvedValue({ dead: false, leaseLost: true });

    await expect(processExternalTasks(env)).resolves.toEqual({
      claimed: 1, completed: 0, failed: 1, dead: 0,
    });
  });
});
