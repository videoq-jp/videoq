import { features } from "./deployment";
import { abortR2MultipartUpload, deleteR2Object, deleteVisualChunks } from "../integrations/media";
import { frameCacheKey, focusCacheKey } from "./video-evidence";
import {
  claimExternalTasks,
  completeExternalTask,
  completeStorageCleanupTask,
  failExternalTask,
  type ClaimedExternalTask,
} from "../repositories/external-task-repository";
import type { Bindings } from "../types/bindings";
import { deliverInvitationEmail } from "./invitation-delivery";
import { sendSqsMessage } from "./sqs";
import { armMaintenance, DISPATCH_SAFETY_NET_MS } from "./task-scheduler";
import { JOB_DELETE_ACCOUNT_DATA } from "./job-message";
import { deleteAccountBilling } from "../features/billing/account-deletion";

export type ExternalTaskRunResult = {
  claimed: number;
  completed: number;
  failed: number;
  dead: number;
};

function objectPayload(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("External task payload must be an object.");
  }
  return value as Record<string, unknown>;
}

async function runTask(env: Bindings, task: ClaimedExternalTask): Promise<void> {
  if (task.kind === "sqs_job") {
    const message = objectPayload(task.payload.message);
    // Retire already-persisted evaluation deliveries without contacting SQS.
    if (message.type === "evaluate_chat_log") {
      await completeExternalTask(env, task);
      return;
    }
    if (message.type === JOB_DELETE_ACCOUNT_DATA) {
      const { user_id: userId } = objectPayload(message.payload);
      if (typeof userId !== "string" || !userId) throw new Error("Account deletion user_id is invalid.");
      await deleteAccountBilling(env, userId);
    }
    const messageId = await sendSqsMessage(env, JSON.stringify(message));
    if (!messageId) throw new Error("SQS job delivery failed.");
    await completeExternalTask(env, task);
    return;
  }

  if (task.kind === "storage_cleanup") {
    const fileKey = task.payload.file_key;
    const userId = task.payload.user_id;
    const bytes = task.payload.bytes;
    if (fileKey !== null && typeof fileKey !== "string") {
      throw new Error("Storage cleanup file_key is invalid.");
    }
    if (typeof userId !== "string") {
      throw new Error("Storage cleanup user_id is invalid.");
    }
    if (bytes !== null && (typeof bytes !== "number" || !Number.isSafeInteger(bytes))) {
      throw new Error("Storage cleanup bytes is invalid.");
    }
    if (fileKey) {
      const uploadId = task.payload.multipart_upload_id;
      if (uploadId !== undefined) {
        if (typeof uploadId !== "string" || !uploadId) throw new Error("Storage cleanup multipart upload ID is invalid.");
        await abortR2MultipartUpload(env, fileKey, uploadId);
      }
      await deleteR2Object(env, fileKey);
      await deleteR2Object(env, frameCacheKey(fileKey));
      await deleteR2Object(env, focusCacheKey(fileKey));
      await deleteR2Object(env, `${fileKey}.focus-v2.json`);
      await deleteVisualChunks(env, fileKey);
    }
    await completeStorageCleanupTask(env, {
      lease: task,
      userId,
      bytes: bytes,
    });
    return;
  }

  if (task.kind === "invitation_email") {
    if (!features(env).emailDelivery) { await completeExternalTask(env, task); return; }
    const invitationId = task.payload.invitation_id;
    if (typeof invitationId !== "number" || !Number.isSafeInteger(invitationId)) {
      throw new Error("Invitation email invitation_id is invalid.");
    }
    // 取り消し済み・承認済みの招待は送らずにタスクだけ閉じる。
    const result = await deliverInvitationEmail(env, invitationId, task);
    // 送信をスキップした場合は上の transaction が走らないので、ここで閉じる。
    if (!("delivered" in result)) await completeExternalTask(env, task);
    return;
  }

  throw new Error(`Unsupported external task kind: ${String(task.kind)}`);
}

export async function processExternalTasks(
  env: Bindings,
  options: { limit?: number; taskId?: number; arm?: boolean } = {},
): Promise<ExternalTaskRunResult> {
  const limit = options.taskId === undefined ? (options.limit ?? 50) : 1;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new Error("External task limit must be an integer between 1 and 100.");
  }

  // 着手前に保険のアラームを張る。この実行が Worker ごと落ちても、
  // 掴んだままのリースとバックオフ待ちを TASK_SCHEDULER が拾い直す。
  // 起床を自分で管理する呼び出し元（alarm / 日次 cron）は arm: false。
  if (options.arm !== false) {
    await armMaintenance(env, Date.now() + DISPATCH_SAFETY_NET_MS);
  }
  const result: ExternalTaskRunResult = {
    claimed: 0,
    completed: 0,
    failed: 0,
    dead: 0,
  };

  // Claim only when ready to execute; later tasks must not wait out their lease.
  // Exclude attempted IDs so a slow run does not retry its own failed deliveries.
  const attemptedIds: number[] = [];
  for (let index = 0; index < limit; index += 1) {
    const [task] = await claimExternalTasks(env, {
      limit: 1,
      taskId: options.taskId,
      excludeTaskIds: [...attemptedIds],
    });
    if (!task) break;
    attemptedIds.push(task.id);
    result.claimed += 1;
    try {
      await runTask(env, task);
      result.completed += 1;
    } catch (error) {
      result.failed += 1;
      const message = error instanceof Error ? error.message : String(error);
      const failure = await failExternalTask(env, task, message);
      if (failure.dead) result.dead += 1;
      console.error(
        JSON.stringify({
          event: failure.leaseLost ? "external_task_lease_lost"
            : failure.dead ? "external_task_dead" : "external_task_failed",
          taskId: task.id,
          attempt: task.attempt,
          kind: task.kind,
          error: message,
        }),
      );
    }
  }
  return result;
}

/** The caller has committed the task; delivery failures are recovered from the outbox. */
export async function processExternalTaskById(
  env: Bindings,
  taskId: number,
): Promise<boolean> {
  try {
    const result = await processExternalTasks(env, { taskId });
    return result.completed === 1;
  } catch (error) {
    // Claiming or recording a failure can itself fail. Recovery was requested
    // before claiming; the daily sweep also recovers interrupted leases.
    console.error(JSON.stringify({
      event: "external_task_dispatch_failed",
      taskId,
      error: error instanceof Error ? error.message : String(error),
    }));
    return false;
  }
}
