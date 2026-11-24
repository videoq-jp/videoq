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
export type SceneIndexOutcome =
  | { status: 'completed'; sceneCount: number }
  | { status: 'skipped'; reason: 'missing_source' | 'already_completed' }
  | { status: 'pending_delivery' }
  | { status: 'source_changed'; phase: 'start' | 'stage' | 'publish' | 'finish' }
  | { status: 'not_ready' }
  | { status: 'invalid_transcript'; reason: 'empty' | 'malformed' | 'split_empty' }
  | { status: 'invalid_embeddings' };

export async function executeSceneIndex(videoId: number, deps: SceneIndexExecutionDependencies, options: { finishIndexing?: boolean; allowEmpty?: boolean } = {}): Promise<SceneIndexOutcome> {
  const source = await deps.load(videoId);
  if (!source) return { status: 'skipped', reason: 'missing_source' };
  if (options.finishIndexing) {
    if (source.status === 'completed') return { status: 'skipped', reason: 'already_completed' };
    if (source.status !== 'indexing') return { status: 'not_ready' };
    const status = await deps.finish(source);
    if (status === 'completed') return { status: 'skipped', reason: 'already_completed' };
    if (status === 'pending') return { status: 'pending_delivery' };
    if (status === 'stale') return { status: 'source_changed', phase: 'finish' };
    if (!source.transcript.trim() && !options.allowEmpty) return { status: 'invalid_transcript', reason: 'empty' };
  }
  const transcript = source.transcript.trim();
  if (transcript && !parseSearchScenes(transcript).length) return { status: 'invalid_transcript', reason: 'malformed' };
  const scenes = transcript ? parseSearchScenes(await deps.split(source.transcript)) : [];
  if (transcript && !scenes.length) return { status: 'invalid_transcript', reason: 'split_empty' };
  const runId = deps.newRunId();
  if (!await deps.start({ runId, videoId, userId: source.userId, sourceRevision: source.sourceRevision, dimensions: deps.dimensions, expectedScenes: scenes.length })) {
    return { status: 'source_changed', phase: 'start' };
  }
  for (let offset = 0; offset < scenes.length; offset += 20) {
    const chunk = scenes.slice(offset, offset + 20);
    const vectors = await deps.embed(chunk.map(s => s.text));
    if (vectors.length !== chunk.length) return { status: 'invalid_embeddings' };
    if (!await deps.stage(runId, source.userId, chunk.map((scene, i) => ({
      id: `${runId}:${offset + i}`, content: scene.text, startTime: scene.startTime, endTime: scene.endTime, embedding: vectors[i],
    })))) return { status: 'source_changed', phase: 'stage' };
  }
  if (!await deps.publish(runId, source.userId)) return { status: 'source_changed', phase: 'publish' };
  if (options.finishIndexing) {
    const status = await deps.finish(source);
    if (status === 'stale') return { status: 'source_changed', phase: 'finish' };
    if (status !== 'completed') return { status: 'pending_delivery' };
  }
  return { status: 'completed', sceneCount: scenes.length };
}
