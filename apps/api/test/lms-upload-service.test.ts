import { describe, expect, it, vi } from 'vitest';
import { createLmsUploadSnapshot, createLmsUploadService, validateLmsUploadResource, type LmsUploadDependencies } from '../src/features/lms/upload-service';
const grant = { id: 'school', ownerUserId: 'owner' };
const snapshot = { resourceId: 'resource', externalId: 'source', generation: 1, videoId: 1, fileKey: 'original', size: 3, contentType: 'video/mp4' };
function fixture() {
  const attempt = { id: 'attempt', grant, snapshot, fileKey: 'candidate' };
  const deps: LmsUploadDependencies = {
    newAttempt: () => attempt,
    prepare: vi.fn(async () => true), adopt: vi.fn(async () => true), abandon: vi.fn(async () => {}),
    scheduleCleanup: vi.fn(async () => {}), cleanupDeferred: vi.fn(),
    objectSize: vi.fn(async () => 3), confirm: vi.fn(async () => ({ status: 'queued' as const, job: { taskId: 9 } })),
    deliver: vi.fn(async () => {}),
  };
  const transfer = { write: vi.fn(async () => {}), expired: () => false };
  return { deps, transfer, attempt, service: createLmsUploadService(deps) };
}
describe('LMS upload lifecycle', () => {
  it('prepares the claim and recovery before writing, then adopts', async () => {
    const { deps, transfer, attempt, service } = fixture();
    const order: string[] = [];
    vi.mocked(deps.prepare).mockImplementation(async () => { order.push('prepare'); return true; });
    vi.mocked(deps.scheduleCleanup).mockImplementation(async () => { order.push('recovery'); });
    transfer.write.mockImplementation(async () => { order.push('write'); });
    vi.mocked(deps.adopt).mockImplementation(async () => { order.push('adopt'); return true; });
    await service.upload(grant, snapshot, () => transfer);
    expect(order).toEqual(['prepare', 'recovery', 'write', 'adopt']);
    expect(deps.adopt).toHaveBeenCalledWith(attempt);
    expect(deps.scheduleCleanup).toHaveBeenCalledWith(7200000);
    expect(deps.abandon).not.toHaveBeenCalled();
  });
  it('does not write or adopt when the claim is rejected', async () => {
    const { deps, transfer, service } = fixture();
    vi.mocked(deps.prepare).mockResolvedValue(false);
    await expect(service.upload(grant, snapshot, () => transfer)).rejects.toMatchObject({ code: 'UPLOAD_UNAVAILABLE' });
    expect(transfer.write).not.toHaveBeenCalled();
    expect(deps.adopt).not.toHaveBeenCalled();
  });
  it.each(['write', 'adopt'] as const)('abandons a failed %s and schedules immediate cleanup', async phase => {
    const { deps, transfer, attempt, service } = fixture();
    const error = new Error('failure');
    if (phase === 'write') transfer.write.mockRejectedValue(error);
    else vi.mocked(deps.adopt).mockRejectedValue(error);
    await expect(service.upload(grant, snapshot, () => transfer)).rejects.toBe(error);
    expect(deps.abandon).toHaveBeenCalledWith(attempt);
    expect(deps.scheduleCleanup).toHaveBeenLastCalledWith(0);
  });
  it('does not adopt an expired transfer even when storage completed', async () => {
    const { deps, transfer, service } = fixture();
    transfer.expired = () => true;
    await expect(service.upload(grant, snapshot, () => transfer)).rejects.toMatchObject({ code: 'UPLOAD_EXPIRED' });
    expect(deps.adopt).not.toHaveBeenCalled();
    expect(deps.abandon).toHaveBeenCalled();
  });
  it('keeps the original failure when abandonment fails and leaves cleanup scheduled', async () => {
    const { deps, transfer, service } = fixture();
    const error = new Error('storage failed');
    transfer.write.mockRejectedValue(error);
    vi.mocked(deps.abandon).mockRejectedValue(new Error('database unavailable'));
    await expect(service.upload(grant, snapshot, () => transfer)).rejects.toBe(error);
    expect(deps.cleanupDeferred).toHaveBeenCalledOnce();
    expect(deps.scheduleCleanup).toHaveBeenLastCalledWith(0);
  });
  it('rejects adoption fenced by a newer generation', async () => {
    const { deps, transfer, service } = fixture();
    vi.mocked(deps.adopt).mockResolvedValue(false);
    await expect(service.upload(grant, snapshot, () => transfer)).rejects.toMatchObject({ code: 'STALE_GENERATION' });
    expect(deps.abandon).toHaveBeenCalled();
  });
  it('does not confirm or deliver when stored bytes do not match', async () => {
    const { deps, service } = fixture();
    vi.mocked(deps.objectSize).mockResolvedValue(null);
    await expect(service.confirm(grant, snapshot, 'uploading')).rejects.toMatchObject({ code: 'UPLOAD_NOT_CONFIRMED' });
    expect(deps.confirm).not.toHaveBeenCalled();
    expect(deps.deliver).not.toHaveBeenCalled();
  });
  it('delivers only after confirmation committed', async () => {
    const { deps, service } = fixture();
    vi.mocked(deps.deliver).mockImplementation(async () => { expect(deps.confirm).toHaveBeenCalledWith(grant, snapshot, true); });
    await service.confirm(grant, snapshot, 'uploading');
    expect(deps.deliver).toHaveBeenCalledWith(9);
  });
  it.each(['already', 'stale'] as const)('does not deliver a %s confirmation', async status => {
    const { deps, service } = fixture();
    vi.mocked(deps.confirm).mockResolvedValue({ status });
    if (status === 'stale') await expect(service.confirm(grant, snapshot, 'pending')).rejects.toMatchObject({ code: 'STALE_GENERATION' });
    else await service.confirm(grant, snapshot, 'pending');
    expect(deps.objectSize).not.toHaveBeenCalled();
    expect(deps.deliver).not.toHaveBeenCalled();
  });
});


describe('LMS upload snapshot policy', () => {
  const source = { resource: { id: 'resource', kind: 'video', enabled: true, generation: 1, fileSize: 3, contentType: 'video/mp4' }, video: { id: 1, file: 'original' } };
  it('projects the current generation into the upload capability', () => {
    expect(createLmsUploadSnapshot(source, 'source', 1)).toEqual(snapshot);
  });
  it.each([
    null, { ...source, video: null },
    { ...source, resource: { ...source.resource, enabled: false } },
    { ...source, resource: { ...source.resource, generation: 2 } },
    { ...source, resource: { ...source.resource, kind: 'course' } },
    { ...source, resource: { ...source.resource, fileSize: null } },
    { ...source, resource: { ...source.resource, contentType: null } },
  ])('rejects unavailable or stale source facts %#', value => {
    expect(() => createLmsUploadSnapshot(value, 'source', 1)).toThrow(expect.objectContaining({ code: 'STALE_GENERATION' }));
  });
});

describe('LMS upload generation before transport validation', () => {
  const source = { resource: { id: 'resource', kind: 'video', enabled: true, generation: 1, fileSize: null, contentType: null }, video: { id: 1, file: 'original' }, ownerUserId: 'owner' };
  it.each(['content', 'confirm'] as const)('preserves %s generation checks before metadata/header validation', operation => {
    expect(() => validateLmsUploadResource(source, 1, operation)).not.toThrow();
    for (const data of [null, { ...source, video: null },
      { ...source, resource: { ...source.resource, enabled: false } },
      { ...source, resource: { ...source.resource, kind: 'course' } },
      { ...source, resource: { ...source.resource, generation: 2 } }]) {
      expect(() => validateLmsUploadResource(data, 1, operation)).toThrow(expect.objectContaining({ kind: 'conflict', code: 'STALE_GENERATION' }));
    }
    expect(() => validateLmsUploadResource(source, Number.NaN, operation)).toThrow(expect.objectContaining({ code: 'STALE_GENERATION' }));
  });
  it('requires a resolved owner at confirmation while retaining the existing content precheck', () => {
    const data = { ...source, ownerUserId: '' };
    expect(() => validateLmsUploadResource(data, 1, 'content')).not.toThrow();
    expect(() => validateLmsUploadResource(data, 1, 'confirm')).toThrow(expect.objectContaining({ code: 'STALE_GENERATION' }));
  });
});
