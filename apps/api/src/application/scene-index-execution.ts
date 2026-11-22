import type { SceneIndexSource, SceneIndexRunInput, SceneEmbedding, FinishSceneIndexResult } from './scene-index-policy';
import { parseSearchScenes } from './search-scene-splitting';

export interface SceneIndexExecutionDependencies {
  load(videoId: number): Promise<SceneIndexSource | null>;
  finish(source: SceneIndexSource): Promise<FinishSceneIndexResult>;
  split(transcript: string): Promise<string>;
  newRunId(): string;
  start(input: SceneIndexRunInput): Promise<boolean>;
  embed(texts: string[]): Promise<number[][]>;
  stage(runId: string, userId: string, scenes: SceneEmbedding[]): Promise<boolean>;
  publish(runId: string, userId: string): Promise<boolean>;
  dimensions: 768 | 1536;
}
export async function executeSceneIndex(videoId: number, deps: SceneIndexExecutionDependencies, options: { finishIndexing?: boolean; allowEmpty?: boolean } = {}): Promise<number> {
  const source = await deps.load(videoId);
  if (!source) return 0;
  if (options.finishIndexing) {
    if (source.status === 'completed') return 0;
    if (source.status !== 'indexing') throw new Error('Video is not ready for indexing');
    const status = await deps.finish(source);
    if (status === 'completed') return 0;
    if (status !== 'missing') throw new Error('Scene index delivery is pending or source changed; retry');
    if (!source.transcript.trim() && !options.allowEmpty) throw new Error('Video has no transcript');
  }
  const transcript = source.transcript.trim();
  if (transcript && !parseSearchScenes(transcript).length) throw new Error('Transcript contains no valid SRT scenes');
  const scenes = transcript ? parseSearchScenes(await deps.split(source.transcript)) : [];
  if (transcript && !scenes.length) throw new Error('Scene splitting produced no valid SRT scenes');
  const runId = deps.newRunId();
  if (!await deps.start({ runId, videoId, userId: source.userId, sourceRevision: source.sourceRevision, dimensions: deps.dimensions, expectedScenes: scenes.length })) {
    throw new Error('Scene source changed before indexing; retry');
  }
  for (let offset = 0; offset < scenes.length; offset += 20) {
    const chunk = scenes.slice(offset, offset + 20);
    const vectors = await deps.embed(chunk.map(s => s.text));
    if (vectors.length !== chunk.length) throw new Error('Embedding row count mismatch');
    if (!await deps.stage(runId, source.userId, chunk.map((scene, i) => ({
      id: `${runId}:${offset + i}`, content: scene.text, startTime: scene.startTime, endTime: scene.endTime, embedding: vectors[i],
    })))) throw new Error('Scene source changed during indexing; retry');
  }
  if (!await deps.publish(runId, source.userId)) throw new Error('Scene source changed before publication; retry');
  if (options.finishIndexing && await deps.finish(source) !== 'completed') throw new Error('Scene index delivery is pending or source changed; retry');
  return scenes.length;
}
