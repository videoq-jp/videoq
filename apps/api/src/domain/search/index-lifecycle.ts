import { parseSearchScenes } from './search-scene-splitting';
import type { FinishSceneIndexResult } from './scene-index-policy';
export function sceneIndexAdmission(status: string | null | undefined, finishIndexing: boolean): 'missing' | 'completed' | 'not_ready' | 'proceed' {
  if (status === undefined || status === null) return 'missing';
  if (!finishIndexing) return 'proceed';
  return status === 'completed' ? 'completed' : status === 'indexing' ? 'proceed' : 'not_ready';
}
export function sceneTranscriptState(transcript: string | null | undefined): 'empty' | 'malformed' | 'valid' {
  if (!transcript?.trim()) return 'empty';
  return parseSearchScenes(transcript).length ? 'valid' : 'malformed';
}
export function sceneTranscriptRequired(finishIndexing: boolean, allowEmpty: boolean): boolean {
  return finishIndexing && !allowEmpty;
}
export function sceneIndexFinishDecision(status: FinishSceneIndexResult): 'completed' | 'pending_delivery' | 'source_changed' | 'build' {
  switch (status) {
    case 'completed': return 'completed';
    case 'pending': return 'pending_delivery';
    case 'stale': return 'source_changed';
    case 'missing': return 'build';
  }
}
export function sceneSplitResultValid(sourceNonempty: boolean, count: number): boolean { return !sourceNonempty || count > 0; }
export function sceneEmbeddingCountValid(sceneCount: number, vectorCount: number): boolean { return sceneCount === vectorCount; }
