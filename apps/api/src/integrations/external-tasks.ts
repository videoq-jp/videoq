import * as workflow from '../features/tasks/service';
import type { ExternalTaskDependencies } from '../features/tasks/ports';
import { features } from '../lib/deployment';
import { abortR2MultipartUpload, deleteR2Object, deleteVisualChunks } from './media';
import { frameCacheKey, focusCacheKey } from '../lib/video-evidence';
import { claimExternalTasks, completeExternalTask, completeStorageCleanupTask, failExternalTask } from '../repositories/external-task-repository';
import { createMultipartUploadRepository, createExternalTaskRepository } from '../persistence/factory';
import { deliverInvitationEmail } from '../lib/invitation-delivery';
import { deliverJob } from './background-jobs/delivery';
import { armMaintenance, DISPATCH_SAFETY_NET_MS } from '../lib/task-scheduler';
import { deleteAccountBilling } from '../features/billing/account-deletion';
import type { Bindings } from '../types/bindings';

function dependencies(env: Bindings): ExternalTaskDependencies {
  return {
    claim: options => claimExternalTasks(env, options), complete: task => completeExternalTask(env, task),
    completeStorage: options => completeStorageCleanupTask(env, options),
    fail: (task, message) => failExternalTask(env, task, message),
    defer: async (task, ms) => (await createExternalTaskRepository(env)).defer(task, ms),
    arm: at => armMaintenance(env, at), now: Date.now, safetyNetMs: DISPATCH_SAFETY_NET_MS,
    get emailDelivery() { return features(env).emailDelivery; },
    deleteBilling: user => deleteAccountBilling(env, user), sendJob: message => deliverJob(env, message),
    hasUploadingFile: async key => (await createMultipartUploadRepository(env)).hasUploadingFile(key),
    referencesFile: async (key, id) => (await createMultipartUploadRepository(env)).referencesFile(key, id),
    abortMultipart: (key, id) => abortR2MultipartUpload(env, key, id),
    deleteObject: key => deleteR2Object(env, key), deleteVisualChunks: key => deleteVisualChunks(env, key),
    frameKey: frameCacheKey, focusKey: focusCacheKey,
    deliverInvitation: (id, lease) => deliverInvitationEmail(env, id, lease),
    diagnostic: event => console.error(JSON.stringify(event)),
  };
}
export function processExternalTasks(env: Bindings, options: { limit?: number; taskId?: number; arm?: boolean } = {}) {
  return workflow.processExternalTasks(dependencies(env), options);
}
export function processExternalTaskById(env: Bindings, taskId: number) {
  return workflow.processExternalTaskById(dependencies(env), taskId);
}
