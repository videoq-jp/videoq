import { createAdminService } from '../features/admin/core';
import { enqueueReindexAllEmbeddings } from '../lib/jobs';
import { processExternalTaskById } from '../lib/external-tasks';
import { lockUserForHardDelete, patchAdminUserFlags } from '../repositories/admin-repository';
import type { Bindings } from '../types/bindings';

/** Capture request credentials at the adapter; the use case sees no HTTP objects. */
export function adminService(env: Bindings, headers: Headers = new Headers()) {
  return createAdminService({
    patchFlags: (actor, target, patch) => patchAdminUserFlags(env, actor, target, patch, headers),
    lockForHardDelete: id => lockUserForHardDelete(env, id),
    processDeletion: taskId => processExternalTaskById(env, taskId),
    enqueueReindexAll: () => enqueueReindexAllEmbeddings(env),
  });
}
