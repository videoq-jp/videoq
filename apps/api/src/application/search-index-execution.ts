import { sceneTranscriptState, sceneSplitResultValid, sceneEmbeddingCountValid } from '../domain/search/index-lifecycle';
import { SafeJobError } from '../domain/operations/job-failure';
import { parseSearchScenes, type SearchScene } from '../domain/search/search-scene-splitting';

export interface TranscriptIndexDependencies {
  prepareReplacement(): Promise<(scenes: SearchScene[], vectors: number[][]) => Promise<number>>;
  split(transcript: string): Promise<string>;
  embed(texts: string[]): Promise<number[][]>;
}
/** Provider work finishes before opening the atomic replacement transaction. */
export async function executeTranscriptIndex(videoId: number, transcript: string | null, deps: TranscriptIndexDependencies): Promise<number> {
  if (sceneTranscriptState(transcript) !== 'valid') throw new SafeJobError('INVALID_TRANSCRIPT', false, `Video ${videoId} transcript contains no valid SRT scenes`);
  const replace = await deps.prepareReplacement();
  const scenes = parseSearchScenes(await deps.split(transcript!));
  if (!sceneSplitResultValid(true, scenes.length)) throw new SafeJobError('INVALID_TRANSCRIPT', false, 'Scene splitting produced no valid SRT scenes');
  const vectors = await deps.embed(scenes.map(s => s.text));
  if (!sceneEmbeddingCountValid(scenes.length, vectors.length)) throw new SafeJobError('INVALID_EMBEDDINGS', true, 'Embedding row count mismatch');
  return replace(scenes, vectors);
}

export interface LeasedAccountDeletionDependencies {
  renew(): Promise<boolean>;
  step(): Promise<{ status: 'progress' | 'completed' | 'denied' }>;
}
export async function executeLeasedAccountDeletion(deps: LeasedAccountDeletionDependencies, maxSteps = 500): Promise<void> {
  if (!Number.isSafeInteger(maxSteps) || maxSteps <= 0) throw new Error('Invalid account deletion step budget');
  for (let i = 0; i < maxSteps; i++) {
    if (!await deps.renew()) throw new Error('Account deletion execution lease was lost');
    const result = await deps.step();
    if (result.status === 'completed') return;
    if (result.status !== 'progress') throw new Error('Account deletion authorization was lost');
  }
  throw new Error('Account deletion step budget exhausted; retry remaining work');
}
