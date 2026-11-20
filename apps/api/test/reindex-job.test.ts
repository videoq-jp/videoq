import { expect, it, vi } from 'vitest';
import { enqueueReindexAllEmbeddings } from '../src/application/reindex-job';

it('delivers only after persistence commits and returns the persisted identity when delivery is delayed', async () => {
  const dispatch = vi.fn().mockResolvedValue(false);
  const persist = vi.fn(async () => {
    expect(dispatch).not.toHaveBeenCalled();
    return { id: 9 };
  });
  const deps = { newId: vi.fn().mockReturnValue('stable-job'), persist, dispatch };
  await expect(enqueueReindexAllEmbeddings(deps)).resolves.toBe('stable-job');
  expect(persist).toHaveBeenCalledExactlyOnceWith({
    type: 'reindex_all_videos_embeddings', job_id: 'stable-job', payload: {},
  });
  expect(dispatch).toHaveBeenCalledExactlyOnceWith(9);
  expect(deps.newId).toHaveBeenCalledOnce();
});

it('never delivers an uncommitted job', async () => {
  const failure = new Error('outbox unavailable');
  const deps = {
    newId: () => 'stable-job', persist: vi.fn().mockRejectedValue(failure), dispatch: vi.fn(),
  };
  await expect(enqueueReindexAllEmbeddings(deps)).rejects.toBe(failure);
  expect(deps.dispatch).not.toHaveBeenCalled();
});

it('preserves unexpected dispatch rejection without persisting a second job', async () => {
  const failure = new Error('recovery scheduling unavailable');
  const deps = {
    newId: () => 'stable-job', persist: vi.fn().mockResolvedValue({ id: 9 }),
    dispatch: vi.fn().mockRejectedValue(failure),
  };
  await expect(enqueueReindexAllEmbeddings(deps)).rejects.toBe(failure);
  expect(deps.persist).toHaveBeenCalledOnce();
});
