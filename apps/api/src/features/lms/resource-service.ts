import { ApplicationError } from '../../application/errors';
import type { ResourceManifest } from '../../application/lms-resource';
import type { LmsGrant, LmsResourceData, LmsResourceSyncRepository } from '../../persistence/contracts/lms-resource-repository';

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

export function lmsResourceStatus(input: {
  enabled: boolean; syncError: string | null; kind: string; videoStatus?: string | null;
}): string {
  return !input.enabled ? 'disabled' : input.syncError ? 'blocked'
    : input.kind === 'course' ? 'completed' : input.videoStatus ?? 'awaiting_upload';
}

/** Select upload eligibility here; adapters resolve the storage URL and method. */
export function lmsResourceState({ resource, video }: {
  resource: Pick<LmsResourceData['resource'], 'generation' | 'enabled' | 'kind' | 'syncError' | 'contentType' | 'fileSize'>;
  video: Pick<NonNullable<LmsResourceData['video']>, 'status' | 'file'> | null;
}) {
  return {
    generation: resource.generation,
    status: lmsResourceStatus({ ...resource, videoStatus: video?.status }),
    error: resource.syncError,
    upload: resource.kind === 'video' && resource.enabled && video?.status === 'uploading'
      ? { fileKey: video.file, contentType: resource.contentType!, size: resource.fileSize! } : null,
  };
}
