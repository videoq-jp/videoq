import { describe, expect, it, vi } from 'vitest';
import { createAdminService, type AdminDependencies } from '../src/features/admin/core';

function setup() {
  const deps = {
    patchFlags: vi.fn<AdminDependencies<{ id: string }>['patchFlags']>().mockResolvedValue({ id: 'target' }),
    lockForHardDelete: vi.fn<AdminDependencies<unknown>['lockForHardDelete']>().mockResolvedValue({ taskId: 7, jobId: 'job' }),
    processDeletion: vi.fn(async (_taskId: number) => {}),
    enqueueReindexAll: vi.fn(async () => 'reindex'),
  };
  return { deps, service: createAdminService(deps) };
}

describe('admin application workflow', () => {
  it.each([{ is_active: false }, { is_admin: false }])('rejects self lockout without mutation: %j', async patch => {
    const { deps, service } = setup();
    expect(await service.patchFlags('actor', 'actor', patch)).toEqual({ selfLockout: true });
    expect(deps.patchFlags).not.toHaveBeenCalled();
  });
  it('allows a safe self change and propagates the atomic repository outcome', async () => {
    const { deps, service } = setup();
    expect(await service.patchFlags('actor', 'actor', { is_admin: true })).toEqual({ user: { id: 'target' } });
    expect(deps.patchFlags).toHaveBeenCalledWith('actor', 'actor', { is_admin: true });
    deps.patchFlags.mockResolvedValueOnce(null);
    expect(await service.patchFlags('actor', 'missing', {})).toEqual({ notFound: true });
    deps.patchFlags.mockRejectedValueOnce(new Error('credentials revoked'));
    await expect(service.patchFlags('actor', 'target', { is_active: false })).rejects.toThrow('credentials revoked');
  });
  it('never starts deletion when self, missing or another administrator', async () => {
    const { deps, service } = setup();
    expect(await service.deleteUser('actor', 'actor')).toEqual({ self: true });
    expect(deps.lockForHardDelete).not.toHaveBeenCalled();
    for (const result of [{ notFound: true as const }, { forbiddenAdmin: true as const }]) {
      deps.lockForHardDelete.mockResolvedValueOnce(result);
      expect(await service.deleteUser('actor', 'target')).toEqual(result);
    }
    expect(deps.processDeletion).not.toHaveBeenCalled();
  });
  it('only dispatches a committed deletion and propagates delivery failures for retry', async () => {
    const { deps, service } = setup();
    deps.lockForHardDelete.mockRejectedValueOnce(new Error('transaction failed'));
    await expect(service.deleteUser('actor', 'target')).rejects.toThrow('transaction failed');
    expect(deps.processDeletion).not.toHaveBeenCalled();
    deps.processDeletion.mockRejectedValueOnce(new Error('delivery failed'));
    await expect(service.deleteUser('actor', 'target')).rejects.toThrow('delivery failed');
    expect(await service.deleteUser('actor', 'target')).toEqual({ job_id: 'job' });
    expect(deps.processDeletion).toHaveBeenCalledWith(7);
    expect(await service.enqueueReindexAll()).toEqual({ job_id: 'reindex' });
  });
});
