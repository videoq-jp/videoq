import { expect, it, vi } from 'vitest';
import { pruneAuditRetention } from '../src/features/maintenance/audit-retention-service';

it('does not inspect clocks or open persistence when retention is disabled', async () => {
  const deps = { nowMs: vi.fn(), repository: vi.fn(), reportBacklog: vi.fn() };
  expect(await pruneAuditRetention(undefined, new Date(NaN), deps)).toMatchObject({ enabled: false, backlog: false });
  expect(deps.nowMs).not.toHaveBeenCalled(); expect(deps.repository).not.toHaveBeenCalled();
});
it('stops at the wall budget before starting another kind and reports resumable backlog', async () => {
  const pruneBatch = vi.fn().mockResolvedValue({ count: 1, more: true });
  let reads = 0;
  const reportBacklog = vi.fn();
  const result = await pruneAuditRetention(30, new Date('2026-11-06T00:00:00Z'), {
    nowMs: () => ++reads <= 3 ? 0 : 25000, repository: async () => ({ pruneBatch }), reportBacklog,
  });
  expect(pruneBatch).toHaveBeenCalledExactlyOnceWith('material', new Date('2026-10-07T00:00:00Z'));
  expect(result).toMatchObject({ materialOperations: 1, tagOperations: 0, backlog: true });
  expect(reportBacklog).toHaveBeenCalledOnce();
});
