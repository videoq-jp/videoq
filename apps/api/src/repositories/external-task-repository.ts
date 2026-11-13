import type { Bindings } from "../types/bindings";
import type { JobMessage } from "../lib/job-message";
import type { ExternalTaskLease } from "../persistence/contracts/external-task-repository";
import { createExternalTaskRepository } from "../persistence/factory";

export type { ExternalTaskLease, ClaimedExternalTask, PersistedExternalTask, ExternalTaskHealth } from "../persistence/contracts/external-task-repository";

export async function createJobTask(env: Bindings, params: {message: JobMessage;dedupeKey?: string}) {
  return (await createExternalTaskRepository(env)).createJob(params);
}
export async function claimExternalTasks(env: Bindings, params: {limit: number;taskId?: number;excludeTaskIds?: readonly number[]}) {
  return (await createExternalTaskRepository(env)).claim(params);
}
export async function completeExternalTask(env: Bindings, lease: ExternalTaskLease) {
  return (await createExternalTaskRepository(env)).complete(lease);
}
export async function completeStorageCleanupTask(env: Bindings, params: {lease: ExternalTaskLease;userId: string;bytes: number|null}) {
  return (await createExternalTaskRepository(env)).completeStorageCleanup(params);
}
export async function failExternalTask(env: Bindings, lease: ExternalTaskLease, error: string) {
  return (await createExternalTaskRepository(env)).fail(lease,error);
}
export async function getExternalTaskHealth(env: Bindings) {
  return (await createExternalTaskRepository(env)).health();
}
export async function pruneDeliveryHistory(env: Bindings, retentionDays=30,limit=500) {
  return (await createExternalTaskRepository(env)).pruneHistory(retentionDays,limit);
}

export {EXTERNAL_TASK_LEASE_MS} from "../persistence/contracts/external-task-repository";
