import { expect, it, vi } from 'vitest';
import { pruneIdempotencyRetention } from '../src/features/maintenance/idempotency-retention-service';

it('uses the retention defaults and returns the committed deletion count', async () => {
  const prune = vi.fn().mockResolvedValue({ deleted: 37 });
  await expect(pruneIdempotencyRetention(async () => ({ prune }))).resolves.toEqual({ deleted: 37 });
  expect(prune).toHaveBeenCalledExactlyOnceWith(30, 500);
});

it.each([
  [0, 1], [1.5, 1], [NaN, 1], [Infinity, 1], [Number.MAX_SAFE_INTEGER + 1, 1],
  [30, 0], [30, 5001], [30, 1.5], [30, NaN], [30, Infinity],
])('rejects invalid retention bounds (%s, %s) before acquiring any repository', async (days, limit) => {
  const repository = vi.fn();
  await expect(pruneIdempotencyRetention(repository, days, limit)).rejects.toThrow();
  expect(repository).not.toHaveBeenCalled();
});

it('preserves configured bounds and propagates storage failure for the maintenance retry', async () => {
  const failure = new Error('cleanup failed');
  const prune = vi.fn().mockRejectedValue(failure);
  await expect(pruneIdempotencyRetention(async () => ({ prune }), 45, 5000)).rejects.toBe(failure);
  expect(prune).toHaveBeenCalledExactlyOnceWith(45, 5000);
});
