import type { LmsResource, ResourceManifest } from './lms-resource';
import type { UploadReservationFailure } from '../billing/quota-policy';

/** Storage is released by durable cleanup; only an unfinished upload's monthly
 * allowance can be refunded here, with its original period as a fence. */
export function planResourceRemoval(facts: {
  shared: boolean; status: string; bytes: number | null; uploadPeriodStart: string | null;
}) {
  if (facts.shared) return { kind: 'blocked', code: 'SHARED_MATERIAL' } as const;
  return {
    kind: 'remove' as const,
    lateUploadCleanup: facts.status === 'uploading',
    refund: facts.status === 'uploading' && facts.uploadPeriodStart && facts.bytes
      ? { bytes: facts.bytes, periodStart: facts.uploadPeriodStart } : null,
  };
}

/** Deletion clears file identity; temporary disable retains it for re-enabling. */
export function resourceContentValues(previous: Pick<LmsResource,
  'contentHash' | 'contentType' | 'fileSize' | 'youtubeVideoId'> | null | undefined, manifest: ResourceManifest) {
  const clearFile = manifest.kind === 'course' || manifest.deleted;
  return {
    contentHash: clearFile ? null : manifest.file?.contentHash ?? previous?.contentHash ?? null,
    contentType: clearFile ? null : manifest.file?.contentType ?? previous?.contentType ?? null,
    fileSize: clearFile ? null : manifest.file?.size ?? previous?.fileSize ?? null,
    youtubeVideoId: manifest.kind === 'youtube' ? manifest.youtubeVideoId ?? previous?.youtubeVideoId ?? null : null,
  };
}

/** A course entry owns its title; individual media cannot overwrite that title. */
export function resourceCourseTitle(manifest: ResourceManifest, hasCourseEntry: boolean): string | null {
  return manifest.kind === 'course' || !hasCourseEntry ? manifest.courseTitle ?? null : null;
}

export type ResourceUploadError = 'STORAGE_LIMIT_EXCEEDED' | 'MONTHLY_UPLOAD_LIMIT_EXCEEDED';
export interface ResourceErrorChoice<Predicate, Value> {
  code(code: ResourceUploadError): Value;
  when(predicate: Predicate, yes: Value, no: Value): Value;
}

/** Failed reservations prioritize account/storage denial, then monthly denial.
 * The fallback also covers a rejected physical safe-integer representation. */
export function resourceUploadError<Predicate, Value>(storageBlocked: Predicate, monthlyLimited: Predicate,
  choice: ResourceErrorChoice<Predicate, Value>): Value {
  const storage = choice.code('STORAGE_LIMIT_EXCEEDED');
  return choice.when(storageBlocked, storage, choice.when(monthlyLimited, choice.code('MONTHLY_UPLOAD_LIMIT_EXCEEDED'), storage));
}

export function resourceUploadReservationError(failure: UploadReservationFailure): ResourceUploadError {
  return resourceUploadError('overQuota' in failure || 'exceeded' in failure, 'monthlyUploadExceeded' in failure, {
    code: code => code,
    when: (predicate, yes, no) => predicate ? yes : no,
  });
}
