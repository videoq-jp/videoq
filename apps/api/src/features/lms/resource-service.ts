import { ApplicationError } from '../../application/errors';
import type { ResourceManifest } from '../../domain/lms/lms-resource';
import type { LmsGrant, LmsResourceSyncRepository } from '../../persistence/contracts/lms-resource-repository';

export function createLmsResourceService(deps: {
  youtube: () => boolean;
  validExternalId: (value: string) => boolean;
  digest: (value: string) => Promise<string>;
  repository: () => Promise<LmsResourceSyncRepository>;
}) {
  return {
    async sync(grant: LmsGrant, externalId: string, manifest: ResourceManifest) {
      if (manifest.kind === 'youtube' && manifest.enabled && !deps.youtube()) {
        throw new ApplicationError('forbidden', 'YOUTUBE_DISABLED', 'YOUTUBE_DISABLED');
      }
      if (!deps.validExternalId(externalId)) {
        throw new ApplicationError('validation', 'INVALID_MANIFEST', 'INVALID_MANIFEST');
      }
      const manifestHash = await deps.digest(JSON.stringify(manifest));
      return (await deps.repository()).sync(grant, externalId, manifest, manifestHash);
    },
  };
}

/** Recovery becomes eligible only after synchronization has committed. */
export async function synchronizeLmsResourceWithRecovery(deps: {
  sync(): Promise<unknown>;
  now(): number;
  schedule(at: number): Promise<void>;
  abandonedUploadMs: number;
}, manifest: ResourceManifest): Promise<void> {
  await deps.sync();
  if (manifest.kind !== 'course') {
    await deps.schedule(deps.now());
    if (!manifest.kind) await deps.schedule(deps.now() + deps.abandonedUploadMs);
  }
}

export { lmsResourceStatus, lmsResourceState } from '../../domain/lms/resource-state';
