import * as workflow from '../features/lms/materials-sync-service';
import type { MaterialsSyncDependencies } from '../features/lms/materials-sync-ports';
import { teachingConnection } from '../features/teaching/service';
import { materialStateKey } from '../features/lms/material-state-key';
import { ltiMaterialsEnabled } from '../features/lti/config';
import { createMaterialsSyncRepository } from '../persistence/factory';
import { getLmsResource, syncLmsResource } from '../repositories/lms-resource-repository';
import { getR2ObjectSize, presignR2Put } from './media';
import { processExternalTaskById } from '../lib/external-tasks';
import { armMaintenance } from '../lib/task-scheduler';
import { MaterialsClient } from '../features/lti/materials-client';
import { LmsSyncError } from '../features/lms/resource';
import type { Bindings } from '../types/bindings';

function dependencies(env: Bindings): MaterialsSyncDependencies {
  return {
    get enabled() { return ltiMaterialsEnabled(env); },
    teacher: (installation, context) => teachingConnection(env, 'moodle', installation, context),
    repository: () => createMaterialsSyncRepository(env), stateKey: materialStateKey,
    newId: () => crypto.randomUUID(), client: connection => new MaterialsClient(env, connection),
    syncResource: (grant, id, manifest) => syncLmsResource(env, grant, id, manifest),
    resource: (grant, id) => getLmsResource(env, grant, id),
    youtubeDisabled: error => error instanceof LmsSyncError && error.code === 'YOUTUBE_DISABLED',
    uploadUrl: (key, type, size) => presignR2Put(env, key, type, size),
    objectSize: key => getR2ObjectSize(env, key), processTask: id => processExternalTaskById(env, id),
    scheduleRecovery: () => armMaintenance(env, Date.now()),
  };
}
export function synchronizeMaterials(env: Bindings, installationId: string, contextId: string) {
  return workflow.synchronizeMaterials(dependencies(env), installationId, contextId);
}
export function sweepMaterials(env: Bindings) { return workflow.sweepMaterials(dependencies(env)); }
