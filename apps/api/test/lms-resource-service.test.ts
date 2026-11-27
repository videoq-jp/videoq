import { expect, it, vi } from 'vitest';
import type { ResourceManifest } from '../src/domain/lms/lms-resource';
import { createLmsResourceService, lmsResourceState, lmsResourceStatus, synchronizeLmsResourceWithRecovery } from '../src/features/lms/resource-service';

const manifest: ResourceManifest = {
  generation: 1, contextId: 'course', resourceLinkId: 'link', enabled: true,
  title: 'Video', kind: 'youtube', youtubeVideoId: 'video',
};

function dependencies() {
  const sync = vi.fn();
  return {
    youtube: vi.fn(() => false), validExternalId: vi.fn(() => true),
    digest: vi.fn(async () => 'hash'), repository: vi.fn(async () => ({ sync })), sync,
  };
}

it('rejects disabled YouTube ingestion before validating identity or accessing persistence', async () => {
  const deps = dependencies();
  await expect(createLmsResourceService(deps).sync({ id: 'grant' }, 'external', manifest))
    .rejects.toMatchObject({ kind: 'forbidden', code: 'YOUTUBE_DISABLED' });
  expect(deps.validExternalId).not.toHaveBeenCalled();
  expect(deps.digest).not.toHaveBeenCalled();
  expect(deps.repository).not.toHaveBeenCalled();
});

it('rejects invalid identity before hashing or opening the repository', async () => {
  const deps = dependencies();
  deps.youtube.mockReturnValue(true);
  deps.validExternalId.mockReturnValue(false);
  await expect(createLmsResourceService(deps).sync({ id: 'grant' }, 'invalid', manifest))
    .rejects.toMatchObject({ kind: 'validation', code: 'INVALID_MANIFEST' });
  expect(deps.digest).not.toHaveBeenCalled();
  expect(deps.repository).not.toHaveBeenCalled();
});

it('allows tombstones without feature evaluation and preserves the exact manifest digest and grant', async () => {
  const deps = dependencies();
  const tombstone = { ...manifest, enabled: false };
  const grant = { id: 'grant', materialsLease: { id: 'lease', token: 'fence' } };
  deps.digest.mockImplementation(async serialized => {
    expect(deps.repository).not.toHaveBeenCalled();
    expect(serialized).toBe(JSON.stringify(tombstone));
    return 'canonical-hash';
  });
  await createLmsResourceService(deps).sync(grant, 'external', tombstone);
  expect(deps.youtube).not.toHaveBeenCalled();
  expect(deps.sync).toHaveBeenCalledExactlyOnceWith(grant, 'external', tombstone, 'canonical-hash');
});

it.each([
  [false, 'failure', 'course', 'processing', 'disabled'],
  [true, 'failure', 'course', 'processing', 'blocked'],
  [true, null, 'course', 'processing', 'completed'],
  [true, null, 'video', 'processing', 'processing'],
  [true, null, 'video', null, 'awaiting_upload'],
] as const)('preserves resource status precedence (%s, %s, %s, %s)', (enabled, syncError, kind, videoStatus, expected) => {
  expect(lmsResourceStatus({ enabled, syncError, kind, videoStatus })).toBe(expected);
});

it.each([
  ['video', true, 'uploading', true],
  ['video', false, 'uploading', false],
  ['course', true, 'uploading', false],
  ['youtube', true, 'uploading', false],
  ['video', true, 'processing', false],
  ['video', true, null, false],
] as const)('selects upload eligibility for %s enabled=%s status=%s', (kind, enabled, status, eligible) => {
  const state = lmsResourceState({
    resource: { generation: 7, kind, enabled, syncError: null, contentType: 'video/mp4', fileSize: 123 },
    video: status ? { status, file: 'immutable-key' } : null,
  });
  expect(state.generation).toBe(7);
  expect(state.upload).toEqual(eligible ? { fileKey: 'immutable-key', contentType: 'video/mp4', size: 123 } : null);
});

it.each([
  ['course', []], ['youtube', [10]], [undefined, [10, 120]],
] as const)('schedules recovery after commit for source kind %s', async (kind, deadlines) => {
  const schedule = vi.fn(async (_at: number) => {});
  const sync = vi.fn(async () => { expect(schedule).not.toHaveBeenCalled(); });
  await synchronizeLmsResourceWithRecovery({ sync, schedule, now: vi.fn().mockReturnValueOnce(10).mockReturnValueOnce(20), abandonedUploadMs: 100 }, { ...manifest, kind });
  expect(sync).toHaveBeenCalledOnce();
  expect(schedule.mock.calls.map(([at]) => at)).toEqual(deadlines);
});

it('does not schedule recovery when synchronization fails', async () => {
  const failure = new Error('stale generation'), schedule = vi.fn();
  await expect(synchronizeLmsResourceWithRecovery({ sync: async () => { throw failure; }, schedule, now: () => 10, abandonedUploadMs: 100 }, manifest)).rejects.toBe(failure);
  expect(schedule).not.toHaveBeenCalled();
});

it('preserves a failed immediate schedule without attempting the delayed schedule or repeating the commit', async () => {
  const failure = new Error('scheduler unavailable'), sync = vi.fn(async () => {}), schedule = vi.fn().mockRejectedValue(failure);
  await expect(synchronizeLmsResourceWithRecovery({ sync, schedule, now: () => 10, abandonedUploadMs: 100 }, { ...manifest, kind: undefined })).rejects.toBe(failure);
  expect(sync).toHaveBeenCalledOnce();
  expect(schedule).toHaveBeenCalledOnce();
});
