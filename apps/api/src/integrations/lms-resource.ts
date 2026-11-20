import type { ResourceManifest } from '../application/lms-resource';
import type { LmsGrant } from '../application/lms-upload';
import { synchronizeLmsResourceWithRecovery } from '../features/lms/resource-service';
import { syncLmsResource } from '../repositories/lms-resource-repository';
import { armMaintenance } from '../lib/task-scheduler';
import { ABANDONED_UPLOAD_MS } from '../lib/upload-reconcile';
import type { Bindings } from '../types/bindings';

export function syncLmsResourceWithRecovery(env: Bindings, grant: LmsGrant, externalId: string, manifest: ResourceManifest) {
  return synchronizeLmsResourceWithRecovery({
    sync: () => syncLmsResource(env, grant, externalId, manifest),
    now: Date.now, schedule: at => armMaintenance(env, at), abandonedUploadMs: ABANDONED_UPLOAD_MS,
  }, manifest);
}
