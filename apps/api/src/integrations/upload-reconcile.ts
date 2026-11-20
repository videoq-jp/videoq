import * as workflow from '../features/maintenance/upload-reconcile-service';
import type { UploadReconcileDependencies } from '../features/maintenance/upload-reconcile-service';
import { getR2ObjectSize } from './media';
import { deleteVideoCascade, listStaleUploadingVideos } from '../repositories/video-repository';
import { processExternalTaskById } from '../lib/external-tasks';
import type { Bindings } from '../types/bindings';

function dependencies(env: Bindings): UploadReconcileDependencies {
  return {
    listStale: hours => listStaleUploadingVideos(env, hours), objectSize: key => getR2ObjectSize(env, key),
    deleteVideo: (id, user, options) => deleteVideoCascade(env, id, user, options),
    processTask: id => processExternalTaskById(env, id), now: Date.now,
  };
}
export function reconcileAbandonedUploads(env: Bindings, olderThanHours?: number) {
  return workflow.reconcileAbandonedUploads(dependencies(env), olderThanHours);
}
export function resolveStorageBytesForRelease(env: Bindings, fileKey: string | null) {
  return workflow.resolveStorageBytesForRelease({ objectSize: key => getR2ObjectSize(env, key) }, fileKey);
}
