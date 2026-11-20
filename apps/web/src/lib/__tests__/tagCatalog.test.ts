import { expect, it, vi } from 'vitest';
import { loadTagCatalog } from '@/application/tag-catalog';

it('counts consumed rows rather than unique IDs and keeps the latest duplicate value', async () => {
  const first = { id: 1, name: 'Old' }, updated = { id: 1, name: 'Updated' }, last = { id: 2, name: 'Last' };
  const load = vi.fn().mockResolvedValueOnce({ items: [first], total: 3 })
    .mockResolvedValueOnce({ items: [updated, last], total: 3 });
  await expect(loadTagCatalog(load)).resolves.toEqual([updated, last]);
  expect(load.mock.calls).toEqual([[{ limit: 100, offset: 0 }], [{ limit: 100, offset: 1 }]]);
});

it('does not return a partial catalog when a later page fails', async () => {
  const failure = new Error('next page unavailable');
  const load = vi.fn().mockResolvedValueOnce({ items: [{ id: 1 }], total: 2 }).mockRejectedValueOnce(failure);
  await expect(loadTagCatalog(load)).rejects.toBe(failure);
});
