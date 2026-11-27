import { expect, it } from 'vitest';
import { planVideoPatch, videoTranscriptChanged, videoDeletionAllowed, videoCleanup, videoAbortRefundAllowed, videoRefundBooleanLogic } from '../src/domain/media/video-mutation';
import { buildPendingUploadFileKey } from '../src/domain/media/upload';
import { videoStatusFilters, videoListOrder, countVideoStatuses, videoKeywordMatcher, videoUploadAbandoned } from '../src/domain/media/video-catalog';

it('updates only distinct fields and ties reindexing to a transcript change', () => {
  const fields = { title: 'new', description: '', transcript: 'same' };
  expect(planVideoPatch(fields, { title: true, description: true, transcript: false })).toEqual({ patch: { title: 'new', description: '' }, syncTitle: true, reindex: false });
  expect(planVideoPatch(fields, { title: false, description: false, transcript: true })).toMatchObject({ patch: { transcript: 'same' }, reindex: true });
  expect(planVideoPatch(fields, { title: false, description: false, transcript: false }).patch).toEqual({});
  const logic = { and: (left: boolean, right: boolean) => left && right };
  for (const provided of [false, true]) for (const different of [false, true])
    expect(videoTranscriptChanged(provided, different, logic)).toBe(provided && different);
});

it('fences deletion by expected state/file and treats a heartbeat at the cutoff as fresh', () => {
  const cutoff = new Date('2026-11-20T00:00:00Z');
  const video = { status: 'uploading', file: 'current', heartbeat: cutoff.toISOString() };
  expect(videoDeletionAllowed(undefined, {})).toBe(false);
  expect(videoDeletionAllowed(video, { expectedStatus: 'completed' })).toBe(false);
  expect(videoDeletionAllowed(video, { expectedFileKey: '' })).toBe(false);
  expect(videoDeletionAllowed(video, { inactiveBefore: cutoff })).toBe(false);
  expect(videoDeletionAllowed({ ...video, heartbeat: new Date(cutoff.getTime() - 1).toISOString() }, { inactiveBefore: cutoff })).toBe(true);
  expect(videoDeletionAllowed({ ...video, heartbeat: null }, { inactiveBefore: cutoff })).toBe(true);
  expect(videoDeletionAllowed({ ...video, heartbeat: 'invalid' }, { inactiveBefore: cutoff })).toBe(true);
});

it('prefers reserved bytes, retains zero fallback and creates no file cleanup for an empty path', () => {
  const file = buildPendingUploadFileKey('owner', 5, '.mp4', 1, 'abcdef123456');
  expect(videoCleanup(file, 9)).toEqual({ fileKey: file, bytes: 5 });
  expect(videoCleanup('legacy.mp4', 0)).toEqual({ fileKey: 'legacy.mp4', bytes: 0 });
  expect(videoCleanup('legacy.mp4')).toEqual({ fileKey: 'legacy.mp4', bytes: null });
  expect(videoCleanup('', 9)).toEqual({ fileKey: null, bytes: null });
  for (const status of ['pending', 'processing', 'indexing', 'completed', 'error'])
    expect(videoAbortRefundAllowed(status, 5, videoRefundBooleanLogic)).toBe(false);
  for (const bytes of [0, null]) expect(videoAbortRefundAllowed('uploading', bytes, videoRefundBooleanLogic)).toBe(false);
  expect(videoAbortRefundAllowed('uploading', 5, videoRefundBooleanLogic)).toBe(true);
});

it('preserves filter tokens and defaults unknown ordering without broadening the query', () => {
  expect(videoStatusFilters(' completed, ,pending,completed ')).toEqual(['completed', 'pending', 'completed']);
  expect(videoListOrder('title_asc')).toEqual({ field: 'title', direction: 'asc' });
  expect(videoListOrder('uploaded_at_asc')).toEqual({ field: 'uploadedAt', direction: 'asc' });
  expect(videoListOrder('title_desc')).toEqual({ field: 'title', direction: 'desc' });
  expect(videoListOrder(' title_asc ')).toEqual({ field: 'uploadedAt', direction: 'desc' });
});

it('counts unrecognized states only in the total and returns independent empty counters', () => {
  expect(countVideoStatuses([{ status: 'completed', count: 2 }, { status: 'completed', count: 3 }, { status: 'future', count: 4 }]))
    .toEqual({ total: 9, completed: 5, pending: 0, processing: 0, indexing: 0, error: 0, uploading: 0 });
  const first = countVideoStatuses([]); first.total = 10;expect(countVideoStatuses([]).total).toBe(0);
});

it('matches Unicode literals in either searchable field without interpreting wildcard syntax', () => {
  expect(videoKeywordMatcher('CAFÉ_')({ title: 'café_ lesson', description: '' })).toBe(true);
  expect(videoKeywordMatcher('%')({ title: 'anything', description: '100% complete' })).toBe(true);
  expect(videoKeywordMatcher('%')({ title: 'anything', description: '' })).toBe(false);
  expect(videoKeywordMatcher('日本語')({ title: '', description: '日本語字幕' })).toBe(true);
  const logic = { statusIs: (status: string, expected: 'uploading') => status === expected, and: (left: boolean, right: boolean) => left && right };
  expect(videoUploadAbandoned('completed', true, logic)).toBe(false);
  expect(videoUploadAbandoned('uploading', false, logic)).toBe(false);
  expect(videoUploadAbandoned('uploading', true, logic)).toBe(true);
});
