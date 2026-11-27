import { expect, it, vi } from 'vitest';
import { createVideoEvidenceService, type VisualEvidenceExecution } from '../src/features/evidence/video-evidence-service';
import type { VisualInspectionResult } from '../src/domain/media/visual-evidence';

const video = { id: 1, title: 'Video', sourceType: 'uploaded', fileKey: 'private', transcript: '', transcriptTooLarge: false };
const input = { video_id: 1, query: 'question', start_seconds: 0, end_seconds: 10 };
const result: VisualInspectionResult = { observations: [], sampled_timestamps: [1], sampling_interval_seconds: 5, duration_seconds: 30 };
function fixture() {
  const load = vi.fn().mockResolvedValue(video);
  const execute = createVideoEvidenceService({ videoIds: [1], visualEnabled: true, load });
  const execution = { checkCancelled: vi.fn(), inspect: vi.fn<VisualEvidenceExecution['inspect']>().mockResolvedValue(result) };
  return { load, execute, execution };
}
it('denies out-of-scope videos without loading metadata or invoking a model', async () => {
  const { load, execute, execution } = fixture();
  expect(await execute.focus({ ...input, video_id: 2 }, execution)).toContain('Invalid video_id');
  expect(load).not.toHaveBeenCalled(); expect(execution.inspect).not.toHaveBeenCalled();
});
it('releases serialized execution after a provider failure so the next inspection can run', async () => {
  const { execute, execution } = fixture();
  execution.inspect.mockRejectedValueOnce(new Error('provider failure'));
  const first = execute.inspectClip(input, execution);
  const second = execute.focus(input, execution);
  await expect(first).rejects.toThrow('provider failure');
  await expect(second).resolves.toMatchObject({ status: 'no_observations' });
  expect(execution.inspect).toHaveBeenCalledTimes(2);
});
it('shares call reservations across tool types and serializes in-flight model payloads', async () => {
  const { execute, execution } = fixture();
  let release!: (value: VisualInspectionResult) => void;
  execution.inspect.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  const requests = [
    execute.overview({ video_id: 1, query: 'overview', include_visuals: true }, execution),
    execute.focus(input, execution),
    execute.inspectClip(input, execution),
    execute.skim({ ...input, include_visuals: true }, execution),
  ];
  await vi.waitFor(() => expect(execution.inspect).toHaveBeenCalledTimes(1));
  const fifth = await execute.focus({ ...input, query: 'another' }, execution);
  expect(fifth).toMatchObject({ status: 'unavailable', budget: { remaining_visual_calls: 0 } });
  release(result);
  await Promise.all(requests);
  expect(execution.inspect).toHaveBeenCalledTimes(4);
  expect(execution.inspect.mock.calls.map(call => call[4].maxFrames)).toEqual([16, 16, 8, 8]);
});
it('checks cancellation before loading private metadata when called without a transport adapter', async () => {
  const { execute, execution, load } = fixture();
  execution.checkCancelled.mockImplementation(() => { throw new Error('cancelled'); });
  await expect(execute.focus(input, execution)).rejects.toThrow('cancelled');
  expect(load).not.toHaveBeenCalled();
  expect(execution.inspect).not.toHaveBeenCalled();
});
