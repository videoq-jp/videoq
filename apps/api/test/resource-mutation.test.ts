import { expect, it } from 'vitest';
import type { ResourceManifest } from '../src/domain/lms/lms-resource';
import {
  planResourceRemoval, resourceContentValues, resourceCourseTitle,
  resourceUploadError, resourceUploadReservationError, type ResourceUploadError,
} from '../src/domain/lms/resource-mutation';

const manifest: ResourceManifest = { generation: 2, contextId: 'context', resourceLinkId: 'source', enabled: true, title: 'Video' };
const previous = { contentHash: 'old', contentType: 'video/mp4', fileSize: 100, youtubeVideoId: 'abcdefghijk' };

it('blocks shared material before planning any refund or cleanup', () => {
  expect(planResourceRemoval({ shared: true, status: 'uploading', bytes: 100, uploadPeriodStart: 'period' }))
    .toEqual({ kind: 'blocked', code: 'SHARED_MATERIAL' });
});

it('refunds unfinished upload allowance with the original opaque period fence', () => {
  const period = '2026-11-01 00:00:00.123456+00';
  expect(planResourceRemoval({ shared: false, status: 'uploading', bytes: 100, uploadPeriodStart: period }))
    .toEqual({ kind: 'remove', lateUploadCleanup: true, refund: { bytes: 100, periodStart: period } });
});

it.each(['pending', 'processing', 'completed', 'error'])('does not refund or schedule late PUT cleanup after confirmation: %s', status => {
  expect(planResourceRemoval({ shared: false, status, bytes: 100, uploadPeriodStart: 'period' }))
    .toEqual({ kind: 'remove', lateUploadCleanup: false, refund: null });
});

it.each([
  { bytes: null, uploadPeriodStart: 'period' },
  { bytes: 0, uploadPeriodStart: 'period' },
  { bytes: 100, uploadPeriodStart: null },
  { bytes: 100, uploadPeriodStart: '' },
])('keeps late cleanup eligibility without inventing a refund for missing reservation facts: %j', facts => {
  expect(planResourceRemoval({ shared: false, status: 'uploading', ...facts }))
    .toEqual({ kind: 'remove', lateUploadCleanup: true, refund: null });
});

it('retains file identity on temporary disable and clears it on a tombstone', () => {
  expect(resourceContentValues(previous, { ...manifest, enabled: false }))
    .toEqual({ ...previous, youtubeVideoId: null });
  expect(resourceContentValues(previous, { ...manifest, enabled: false, deleted: true }))
    .toEqual({ contentHash: null, contentType: null, fileSize: null, youtubeVideoId: null });
});

it('takes new file identity while absent source data starts empty', () => {
  expect(resourceContentValues(previous, { ...manifest, file: { filename: 'new.mov', size: 200, contentHash: 'new', contentType: 'video/quicktime' } }))
    .toEqual({ contentHash: 'new', contentType: 'video/quicktime', fileSize: 200, youtubeVideoId: null });
  expect(resourceContentValues(null, manifest))
    .toEqual({ contentHash: null, contentType: null, fileSize: null, youtubeVideoId: null });
});

it('course entries clear media fields while YouTube tombstones retain their source identity', () => {
  expect(resourceContentValues(previous, { ...manifest, kind: 'course' }))
    .toEqual({ contentHash: null, contentType: null, fileSize: null, youtubeVideoId: null });
  expect(resourceContentValues(previous, { ...manifest, kind: 'youtube', enabled: false, deleted: true }))
    .toEqual({ contentHash: null, contentType: null, fileSize: null, youtubeVideoId: previous.youtubeVideoId });
  expect(resourceContentValues(previous, { ...manifest, kind: 'youtube', youtubeVideoId: '123456789ab' }).youtubeVideoId).toBe('123456789ab');
});

it('course entries own titles and video suggestions cannot override an entry', () => {
  const named = { ...manifest, courseTitle: 'Suggested title' };
  expect(resourceCourseTitle(named, true)).toBeNull();
  expect(resourceCourseTitle(named, false)).toBe(named.courseTitle);
  expect(resourceCourseTitle({ ...named, kind: 'course', enabled: false }, true)).toBe(named.courseTitle);
  expect(resourceCourseTitle(manifest, false)).toBeNull();
});

it.each([
  { storageBlocked: true, monthlyLimited: true, expected: 'STORAGE_LIMIT_EXCEEDED' },
  { storageBlocked: true, monthlyLimited: false, expected: 'STORAGE_LIMIT_EXCEEDED' },
  { storageBlocked: false, monthlyLimited: true, expected: 'MONTHLY_UPLOAD_LIMIT_EXCEEDED' },
  { storageBlocked: false, monthlyLimited: false, expected: 'STORAGE_LIMIT_EXCEEDED' },
])('preserves upload error precedence for $storageBlocked / $monthlyLimited', ({ storageBlocked, monthlyLimited, expected }) => {
  expect(resourceUploadError<boolean, ResourceUploadError>(storageBlocked, monthlyLimited, {
    code: code => code, when: (condition, yes, no) => condition ? yes : no,
  })).toBe(expected);
});

it('maps normalized failed reservations through the same error policy', () => {
  expect(resourceUploadReservationError({ overQuota: true })).toBe('STORAGE_LIMIT_EXCEEDED');
  expect(resourceUploadReservationError({ exceeded: true, limit: 0 })).toBe('STORAGE_LIMIT_EXCEEDED');
  expect(resourceUploadReservationError({ monthlyUploadExceeded: true, limit: 0 })).toBe('MONTHLY_UPLOAD_LIMIT_EXCEEDED');
});
