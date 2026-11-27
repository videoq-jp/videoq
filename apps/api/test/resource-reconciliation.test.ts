import { expect, it } from 'vitest';
import type { ResourceManifest } from '../src/domain/lms/lms-resource';
import {
  planResourceReconciliation, resourceCourseBindingMatches, resourceCourseOwnerMatches,
  resourceRevisionConflict, resourceVideoBindingMatches, type ResourceSnapshot, type ResourceVideoSnapshot,
} from '../src/domain/lms/resource-reconciliation';

const file = { filename: 'video.mp4', size: 100, contentType: 'video/mp4', contentHash: 'hash' };
const manifest: ResourceManifest = { generation: 2, contextId: 'context', resourceLinkId: 'source', enabled: true, title: 'Video', file };
const previous: ResourceSnapshot = {
  kind: 'video', contextId: 'context', generation: 1, manifestHash: 'old', courseId: 10, videoId: 20,
  youtubeVideoId: null, contentHash: file.contentHash, fileSize: file.size, contentType: file.contentType,
};
const video: ResourceVideoSnapshot = { userId: 'owner', status: 'uploading', sourceType: 'uploaded', youtubeVideoId: '', transcriptionLanguage: 'en' };
const plan = (m: ResourceManifest = manifest, p: ResourceSnapshot | null = previous, v: ResourceVideoSnapshot | null = video) =>
  planResourceReconciliation('owner', p, v, m, 10);

it('rejects immutable kind/context before stale generation and accepts a matching revision', () => {
  expect(resourceRevisionConflict(previous, { ...manifest, kind: 'course', generation: 0 }, 'old')).toBe('RESOURCE_KIND_OR_CONTEXT_CHANGED');
  expect(resourceRevisionConflict({ ...previous, kind: 'course' }, { ...manifest, kind: 'course', contextId: 'other' }, 'old')).toBe('RESOURCE_KIND_OR_CONTEXT_CHANGED');
  expect(resourceRevisionConflict(previous, { ...manifest, generation: 0 }, 'old')).toBe('STALE_GENERATION');
  expect(resourceRevisionConflict(previous, { ...manifest, generation: 1 }, 'different')).toBe('STALE_GENERATION');
  expect(resourceRevisionConflict(previous, { ...manifest, generation: 1 }, 'old')).toBeNull();
  expect(resourceRevisionConflict(null, manifest, 'new')).toBeNull();
});

it('requires an owned managed course with native access disabled and a stable entry binding', () => {
  const course = { id: 10, userId: 'owner', managedByLms: true, nativeAccessDisabled: true };
  expect(resourceCourseBindingMatches('owner', course, 10)).toBe(true);
  expect(resourceCourseBindingMatches('owner', course, null)).toBe(true);
  for (const changed of [null, { ...course, userId: 'other' }, { ...course, managedByLms: false }, { ...course, nativeAccessDisabled: false }]) {
    expect(resourceCourseBindingMatches('owner', changed, 10)).toBe(false);
  }
  expect(resourceCourseBindingMatches('owner', course, 11)).toBe(false);
  expect(resourceCourseOwnerMatches('owner', null)).toBe(true);
  expect(resourceCourseOwnerMatches('owner', { userId: null })).toBe(false);
  expect(resourceCourseOwnerMatches('owner', { userId: 'other' })).toBe(false);
});

it('never adopts foreign media or a changed YouTube source identity during replay', () => {
  const youtube = { ...manifest, kind: 'youtube' as const, file: undefined, youtubeVideoId: 'abcdefghijk' };
  const oldYoutube = { ...previous, kind: 'youtube', youtubeVideoId: 'abcdefghijk' };
  const source = { ...video, sourceType: 'youtube', youtubeVideoId: 'abcdefghijk' };
  expect(resourceVideoBindingMatches('owner', youtube, oldYoutube, source)).toBe(true);
  expect(resourceVideoBindingMatches('owner', manifest, previous, { ...video, userId: 'other' })).toBe(false);
  expect(resourceVideoBindingMatches('owner', youtube, oldYoutube, video)).toBe(false);
  expect(resourceVideoBindingMatches('owner', youtube, oldYoutube, { ...source, youtubeVideoId: '123456789ab' })).toBe(false);
  expect(resourceVideoBindingMatches('owner', manifest, previous, null)).toBe(true);
});

it('replays a completed generation without reprocessing an errored source or relocking language', () => {
  const result = plan({ ...manifest, generation: 1, transcriptionLanguage: 'ja' }, previous, { ...video, status: 'error' });
  expect(result).toMatchObject({ idempotent: true, replaceSource: false, languageLocked: false, detachMembership: false });
});

it('retries a quota-blocked enabled generation but replays a disabled resource without media', () => {
  expect(plan({ ...manifest, generation: 1 }, { ...previous, videoId: null })).toMatchObject({ idempotent: false, keepVideo: false, replaceSource: true });
  expect(plan({ ...manifest, generation: 1, enabled: false }, { ...previous, videoId: null })).toMatchObject({ idempotent: true, replaceSource: false });
});

it('keeps metadata-only updates and ignores file names when content identity stays equal', () => {
  expect(plan({ ...manifest, title: 'Renamed', file: { ...file, filename: 'renamed.mov' } })).toMatchObject({ keepVideo: true, videoId: 20, replaceSource: false });
  expect(plan(manifest, previous, null).keepVideo).toBe(true);
});

it.each([
  { label: 'hash', file: { ...file, contentHash: 'different' } },
  { label: 'size', file: { ...file, size: 101 } },
  { label: 'type', file: { ...file, contentType: 'video/quicktime' } },
])('replaces changed $label without keeping the old source', ({ file: changed }) => {
  expect(plan({ ...manifest, file: changed })).toMatchObject({ keepVideo: false, videoId: null, replaceSource: true });
});

it('locks only explicitly changed language on enabled reused material', () => {
  expect(plan({ ...manifest, transcriptionLanguage: 'ja' }).languageLocked).toBe(true);
  expect(plan({ ...manifest, transcriptionLanguage: 'en' }).languageLocked).toBe(false);
  expect(plan().languageLocked).toBe(false);
  expect(plan({ ...manifest, enabled: false, transcriptionLanguage: 'ja' }).languageLocked).toBe(false);
  expect(plan(manifest, previous, { ...video, status: 'error' })).toMatchObject({ keepVideo: false, replaceSource: true });
});

it('detaches disabled media without replacing it and clears vocabulary only when moving context', () => {
  expect(plan({ ...manifest, enabled: false, file: undefined })).toMatchObject({ keepVideo: true, replaceSource: false, detachMembership: true, clearPreviousVocabulary: false });
  expect(plan({ ...manifest, contextId: 'next' })).toMatchObject({ keepVideo: true, detachMembership: true, clearPreviousVocabulary: true });
  expect(plan({ ...manifest, enabled: false, deleted: true, file: undefined })).toMatchObject({ keepVideo: false, replaceSource: true });
});

it('keeps course-entry tombstones separate from shared media lifecycle', () => {
  const entry = { ...manifest, kind: 'course' as const, file: undefined, enabled: false, deleted: true };
  expect(plan(entry)).toMatchObject({ keepVideo: false, replaceSource: false, videoId: null, detachMembership: false, clearPreviousVocabulary: false });
  expect(planResourceReconciliation('owner', { ...previous, kind: 'course' }, null, { ...entry, generation: 1 }, 10).idempotent).toBe(true);
  expect(planResourceReconciliation('owner', { ...previous, kind: 'course' }, null, { ...entry, generation: 1, enabled: true, deleted: false }, null).idempotent).toBe(false);
});

it('reuses only matching healthy YouTube content and never invents a missing source', () => {
  const youtube = { ...manifest, kind: 'youtube' as const, file: undefined, youtubeVideoId: 'abcdefghijk' };
  const oldYoutube = { ...previous, kind: 'youtube', youtubeVideoId: 'abcdefghijk' };
  const source = { ...video, sourceType: 'youtube', youtubeVideoId: 'abcdefghijk' };
  expect(plan(youtube, oldYoutube, source).keepVideo).toBe(true);
  expect(plan({ ...youtube, youtubeVideoId: '123456789ab' }, oldYoutube, source).replaceSource).toBe(true);
  expect(plan(youtube, oldYoutube, null).replaceSource).toBe(true);
  expect(plan(manifest, null, null)).toMatchObject({ idempotent: false, keepVideo: false, videoId: null, detachMembership: false });
});
