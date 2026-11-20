import { createJobTask } from "../repositories/external-task-repository";
import type { Bindings } from "../types/bindings";
import { processExternalTaskById } from "./external-tasks";
import { enqueueReindexAllEmbeddings as enqueueReindex } from "../application/reindex-job";

/** 永続化したjob_idを返す。SQS未設定・一時障害でもscheduled処理が再配送する。 */
export function enqueueReindexAllEmbeddings(
  env: Bindings,
): Promise<string> {
  return enqueueReindex({
    newId: () => crypto.randomUUID(),
    persist: message => createJobTask(env, { message }),
    dispatch: taskId => processExternalTaskById(env, taskId),
  });
}
