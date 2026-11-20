import type { ExternalTaskDependencies } from './ports';
import type { ClaimedExternalTask } from '../../persistence/contracts/external-task-repository';
import { JOB_DELETE_ACCOUNT_DATA } from '../../application/job-message';

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

async function runTask(deps: ExternalTaskDependencies, task: ClaimedExternalTask): Promise<void|'deferred'> {
  if (task.kind === "sqs_job") {
    const message = objectPayload(task.payload.message);
    // Retire already-persisted evaluation deliveries without contacting SQS.
    if (message.type === "evaluate_chat_log") {
      await deps.complete(task);
      return;
    }
    if (message.type === JOB_DELETE_ACCOUNT_DATA) {
      const { user_id: userId } = objectPayload(message.payload);
      if (typeof userId !== "string" || !userId) throw new Error("Account deletion user_id is invalid.");
      await deps.deleteBilling(userId);
    }
    const messageId = await deps.sendJob(JSON.stringify(message));
    if (!messageId) throw new Error("SQS job delivery failed.");
    await deps.complete(task);
    return;
  }

  if (task.kind === "storage_cleanup" || task.kind === "multipart_abort" || task.kind === "multipart_cleanup") {
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
    const abortOnly=task.kind==='multipart_abort';
    const orphanOnly=task.kind==='multipart_cleanup';
    if(abortOnly||orphanOnly){
      const uploadId=task.payload.multipart_upload_id;
      if(!fileKey||typeof uploadId!=='string'||!uploadId||bytes!==0)throw new Error('Conditional multipart cleanup payload is invalid.');
      if(orphanOnly&&await deps.hasUploadingFile(fileKey)){
        await deps.defer(task,2*3600000);return 'deferred';
      }
      if(await deps.referencesFile(fileKey,abortOnly?uploadId:undefined)){
        await deps.completeStorage({lease:task,userId,bytes:0});return;
      }
    }
    if (fileKey) {
      const uploadId = task.payload.multipart_upload_id;
      if (uploadId !== undefined) {
        if (typeof uploadId !== "string" || !uploadId) throw new Error("Storage cleanup multipart upload ID is invalid.");
        await deps.abortMultipart(fileKey, uploadId);
      }
      if(!abortOnly){
        await deps.deleteObject( fileKey);
        await deps.deleteObject( deps.frameKey(fileKey));
        await deps.deleteObject( deps.focusKey(fileKey));
        await deps.deleteObject( `${fileKey}.focus-v2.json`);
        await deps.deleteVisualChunks(fileKey);
      }
    }
    await deps.completeStorage( {
      lease: task,
      userId,
      bytes: bytes,
    });
    return;
  }

  if (task.kind === "invitation_email") {
    if (!deps.emailDelivery) { await deps.complete(task); return; }
    const invitationId = task.payload.invitation_id;
    if (typeof invitationId !== "number" || !Number.isSafeInteger(invitationId)) {
      throw new Error("Invitation email invitation_id is invalid.");
    }
    // 取り消し済み・承認済みの招待は送らずにタスクだけ閉じる。
    const result = await deps.deliverInvitation(invitationId, task);
    // 送信をスキップした場合は上の transaction が走らないので、ここで閉じる。
    if (!("delivered" in result)) await deps.complete(task);
    return;
  }

  throw new Error(`Unsupported external task kind: ${String(task.kind)}`);
}

export async function processExternalTasks(
  deps: ExternalTaskDependencies,
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
    await deps.arm(deps.now() + deps.safetyNetMs);
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
    const [task] = await deps.claim( {
      limit: 1,
      taskId: options.taskId,
      excludeTaskIds: [...attemptedIds],
    });
    if (!task) break;
    attemptedIds.push(task.id);
    result.claimed += 1;
    try {
      const outcome=await runTask(deps, task);
      if(outcome!=='deferred')result.completed += 1;
    } catch {
      result.failed += 1;
      // Provider/driver diagnostics can contain signed URLs, tokens and SQL
      // values. Persist a fixed code, never the original message or cause.
      const message = "EXTERNAL_TASK_EXECUTION_FAILED";
      const failure = await deps.fail(task, message);
      if (failure.dead) result.dead += 1;
      deps.diagnostic({
          event: failure.leaseLost ? "external_task_lease_lost"
            : failure.dead ? "external_task_dead" : "external_task_failed",
          taskId: task.id,
          attempt: task.attempt,
          kind: task.kind,
          error: message,
        });
    }
  }
  return result;
}

/** The caller has committed the task; delivery failures are recovered from the outbox. */
export async function processExternalTaskById(
  deps: ExternalTaskDependencies,
  taskId: number,
): Promise<boolean> {
  try {
    const result = await processExternalTasks(deps, { taskId });
    return result.completed === 1;
  } catch {
    // Claiming or recording a failure can itself fail. Recovery was requested
    // before claiming; the daily sweep also recovers interrupted leases.
    deps.diagnostic({
      event: "external_task_dispatch_failed",
      taskId,
    });
    return false;
  }
}
