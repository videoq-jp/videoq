import type { LmsResource } from './lms-resource';
import { lmsUploadMaterialAllowed, lmsUploadMetadata } from './lms-upload';
export function lmsResourceStatus(input: {
  enabled: boolean; syncError: string | null; kind: string; videoStatus?: string | null;
}): string {
  return !input.enabled ? 'disabled' : input.syncError ? 'blocked'
    : input.kind === 'course' ? 'completed' : input.videoStatus ?? 'awaiting_upload';
}

/** Select upload eligibility here; adapters resolve the storage URL and method. */
export function lmsResourceState({ resource, video }: {
  resource: Pick<LmsResource, 'generation' | 'enabled' | 'kind' | 'syncError' | 'contentType' | 'fileSize'>;
  video: { status: string; file: string } | null;
}) {
  const metadata = lmsUploadMetadata(resource);
  return {
    generation: resource.generation,
    status: lmsResourceStatus({ ...resource, videoStatus: video?.status }),
    error: resource.syncError,
    upload: metadata && lmsUploadMaterialAllowed(resource, !!video) && video?.status === 'uploading'
      ? { fileKey: video.file, ...metadata } : null,
  };
}
