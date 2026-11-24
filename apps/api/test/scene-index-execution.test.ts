import { expect, it, vi } from 'vitest';
import { executeSceneIndex, type SceneIndexExecutionDependencies } from '../src/application/scene-index-execution';

const transcript = '1\n00:00:00,000 --> 00:00:01,000\nA synthetic lesson.\n';
function dependencies() {
  return {
    load: vi.fn<SceneIndexExecutionDependencies['load']>(async () => ({ videoId: 1, userId: 'owner', sourceRevision: 'revision', fileKey: 'file', transcript, status: 'indexing' })),
    finish: vi.fn<SceneIndexExecutionDependencies['finish']>().mockResolvedValueOnce('missing').mockResolvedValue('completed'),
    split: vi.fn(async () => transcript), newRunId: () => 'run', start: vi.fn(async () => true),
    embed: vi.fn(async () => [[1, ...Array<number>(767).fill(0)]]),
    stage: vi.fn(async () => true), publish: vi.fn(async () => true), dimensions: 768 as const,
  };
}
it.each(['pending', 'stale'] as const)('returns a typed %s state before any provider work', async status => {
  const deps = dependencies(); deps.finish.mockReset().mockResolvedValue(status);
  expect(await executeSceneIndex(1, deps, { finishIndexing: true })).toEqual(status === 'pending'
    ? { status: 'pending_delivery' } : { status: 'source_changed', phase: 'finish' });
  expect(deps.start).not.toHaveBeenCalled(); expect(deps.embed).not.toHaveBeenCalled();
});
it('returns a completed count only after publication and readiness', async () => {
  const deps = dependencies();
  expect(await executeSceneIndex(1, deps, { finishIndexing: true })).toEqual({ status: 'completed', sceneCount: 1 });
  expect(deps.finish).toHaveBeenCalledTimes(2);
  expect(deps.stage).toHaveBeenCalledWith('run', 'owner', [expect.objectContaining({ id: 'run:0', content: 'A synthetic lesson.' })]);
});
it('does not regenerate embeddings while published data is still pending', async () => {
  const deps = dependencies(); deps.finish.mockReset().mockResolvedValueOnce('missing').mockResolvedValue('pending');
  expect(await executeSceneIndex(1, deps, { finishIndexing: true })).toEqual({ status: 'pending_delivery' });
  expect(await executeSceneIndex(1, deps, { finishIndexing: true })).toEqual({ status: 'pending_delivery' });
  expect(deps.embed).toHaveBeenCalledOnce();
});
it.each(['start', 'stage', 'publish'] as const)('preserves the %s revision fence', async phase => {
  const deps = dependencies(); deps[phase].mockResolvedValue(false);
  expect(await executeSceneIndex(1, deps)).toEqual({ status: 'source_changed', phase });
  if (phase !== 'publish') expect(deps.publish).not.toHaveBeenCalled();
});
it.each(['empty', 'malformed', 'split_empty'] as const)('identifies invalid transcript reason: %s', async reason => {
  const deps = dependencies();
  if (reason !== 'split_empty') deps.load.mockResolvedValue({ videoId: 1, userId: 'owner', sourceRevision: 'revision', fileKey: 'file', status: 'indexing', transcript: reason === 'empty' ? '' : 'invalid' });
  else deps.split.mockResolvedValue('');
  expect(await executeSceneIndex(1, deps, { finishIndexing: true })).toEqual({ status: 'invalid_transcript', reason });
  expect(deps.start).not.toHaveBeenCalled(); expect(deps.embed).not.toHaveBeenCalled();
});
it('distinguishes a provider row-count mismatch and never stages it', async () => {
  const deps = dependencies(); deps.embed.mockResolvedValue([]);
  expect(await executeSceneIndex(1, deps)).toEqual({ status: 'invalid_embeddings' });
  expect(deps.stage).not.toHaveBeenCalled();
});
it('keeps empty manual-clear intent explicit', async () => {
  const deps = dependencies(); deps.load.mockResolvedValue({ videoId: 1, userId: 'owner', sourceRevision: 'revision', fileKey: 'file', status: 'indexing', transcript: '' });
  expect(await executeSceneIndex(1, deps, { finishIndexing: true, allowEmpty: true })).toEqual({ status: 'completed', sceneCount: 0 });
  expect(deps.embed).not.toHaveBeenCalled(); expect(deps.publish).toHaveBeenCalledOnce();
});
it.each(['load', 'finish', 'split', 'start', 'embed', 'stage', 'publish'] as const)('preserves %s I/O errors for the outer retry adapter', async phase => {
  const deps = dependencies(); const error = new Error('synthetic-private-provider-failure');
  deps[phase].mockRejectedValue(error);
  await expect(executeSceneIndex(1, deps, { finishIndexing: true })).rejects.toBe(error);
});

it('skips a removed source without touching providers or publishing', async () => {
  const deps = dependencies(); deps.load.mockResolvedValue(null);
  expect(await executeSceneIndex(1, deps)).toEqual({ status: 'skipped', reason: 'missing_source' });
  expect(deps.embed).not.toHaveBeenCalled(); expect(deps.publish).not.toHaveBeenCalled();
});
it.each(['completed', 'processing'])('keeps %s source admission explicit', async status => {
  const deps = dependencies(); deps.load.mockResolvedValue({ videoId: 1, userId: 'owner', sourceRevision: 'revision', fileKey: 'file', status, transcript });
  expect(await executeSceneIndex(1, deps, { finishIndexing: true })).toEqual(status === 'completed'
    ? { status: 'skipped', reason: 'already_completed' } : { status: 'not_ready' });
  expect(deps.finish).not.toHaveBeenCalled(); expect(deps.embed).not.toHaveBeenCalled();
});
