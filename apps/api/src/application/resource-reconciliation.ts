import type { LmsResource, ResourceManifest } from './lms-resource';

export type ResourceSnapshot = Pick<LmsResource,
  'kind' | 'contextId' | 'generation' | 'manifestHash' | 'courseId' | 'videoId'
  | 'youtubeVideoId' | 'contentHash' | 'fileSize' | 'contentType'>;
export type ResourceVideoSnapshot = {
  userId: string; status: string; sourceType: string; youtubeVideoId: string; transcriptionLanguage: string | null;
};

/** Kind and course-context identity failures take precedence over generation. */
export function resourceRevisionConflict(previous: ResourceSnapshot | null | undefined, manifest: ResourceManifest, manifestHash: string) {
  if (previous && (previous.kind !== (manifest.kind ?? 'video')
    || previous.kind === 'course' && previous.contextId !== manifest.contextId)) return 'RESOURCE_KIND_OR_CONTEXT_CHANGED' as const;
  if (previous && (manifest.generation < previous.generation
    || manifest.generation === previous.generation && manifestHash !== previous.manifestHash)) return 'STALE_GENERATION' as const;
  return null;
}

export function resourceCourseOwnerMatches(ownerUserId: string, mapping: { userId: string | null } | null | undefined): boolean {
  return !mapping || mapping.userId === ownerUserId;
}

export function resourceCourseBindingMatches(ownerUserId: string, course: {
  id: number; userId: string | null; managedByLms: boolean; nativeAccessDisabled: boolean;
} | null | undefined, previousCourseId: number | null | undefined): boolean {
  return Boolean(course && course.userId === ownerUserId && course.managedByLms && course.nativeAccessDisabled
    && (previousCourseId == null || previousCourseId === course.id));
}

/** Do not adopt another owner's media, even during an otherwise idempotent replay. */
export function resourceVideoBindingMatches(ownerUserId: string, manifest: ResourceManifest,
  previous: ResourceSnapshot | null | undefined, video: ResourceVideoSnapshot | null | undefined): boolean {
  return !video || (video.userId === ownerUserId && (manifest.kind !== 'youtube'
    || video.sourceType === 'youtube' && video.youtubeVideoId === previous?.youtubeVideoId));
}

/** Evaluate only transaction-locked or snapshot-fenced facts. This plan grants no access. */
export function planResourceReconciliation(ownerUserId: string, previous: ResourceSnapshot | null | undefined,
  video: ResourceVideoSnapshot | null | undefined, manifest: ResourceManifest, courseId: number | null) {
  const course = manifest.kind === 'course';
  const idempotent = previous?.generation === manifest.generation
    && (!manifest.enabled || (course ? courseId !== null : previous.videoId !== null));
  const keepVideo = !course && !manifest.deleted && previous?.videoId != null && video?.status !== 'error'
    && (manifest.kind === 'youtube'
      ? video?.userId === ownerUserId && video.sourceType === 'youtube'
        && previous.youtubeVideoId === (manifest.youtubeVideoId ?? previous.youtubeVideoId)
        && video.youtubeVideoId === previous.youtubeVideoId
      : previous.contentHash === (manifest.file?.contentHash ?? previous.contentHash)
        && previous.fileSize === (manifest.file?.size ?? previous.fileSize)
        && previous.contentType === (manifest.file?.contentType ?? previous.contentType));
  const detachMembership = !idempotent && !course && previous?.courseId != null && previous.videoId != null;
  return {
    idempotent, keepVideo, videoId: keepVideo ? previous.videoId : null,
    languageLocked: !idempotent && manifest.enabled && keepVideo && manifest.transcriptionLanguage !== undefined
      && video?.transcriptionLanguage !== manifest.transcriptionLanguage,
    detachMembership,
    clearPreviousVocabulary: detachMembership && previous.contextId !== manifest.contextId,
    replaceSource: !idempotent && !course && !keepVideo,
  };
}
