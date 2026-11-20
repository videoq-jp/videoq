export type SceneEmbedding = {
  id: string; content: string; startTime: string; endTime: string;
  evidenceType?: 'transcript' | 'visual'; embedding: number[];
};
export type SceneIndexRunInput = {
  runId: string; videoId: number; userId: string; sourceRevision: string;
  dimensions: 768 | 1536; expectedScenes: number;
};
export type SceneIndexSource = {
  videoId: number; userId: string; sourceRevision: string; fileKey: string; transcript: string; status: string;
};
export type FinishSceneIndexInput = {
  videoId: number; userId: string; sourceRevision: string; fileKey: string; dimensions: 768 | 1536;
};
export type FinishSceneIndexResult = 'completed' | 'pending' | 'missing' | 'stale';

export function validateSceneIndexRun(input: { dimensions: number; expectedScenes: number; runId: string }): void {
  if (![768, 1536].includes(input.dimensions) || !Number.isSafeInteger(input.expectedScenes) || input.expectedScenes < 0 ||
    !input.runId || input.runId.length > 128) throw new Error('Invalid scene index run');
}

/** Byte budgets belong to the provider adapter; semantic validation belongs here. */
export function validateSceneEmbedding(scene: SceneEmbedding, dimensions: number, facts: { idFits: boolean; duplicate: boolean }): void {
  if (!scene.id || !facts.idFits || facts.duplicate ||
    typeof scene.content !== 'string' || typeof scene.startTime !== 'string' || typeof scene.endTime !== 'string' ||
    scene.evidenceType !== undefined && !['transcript', 'visual'].includes(scene.evidenceType) ||
    !Array.isArray(scene.embedding) || scene.embedding.length !== dimensions || !scene.embedding.every(value => Number.isFinite(value) && Number.isFinite(Math.fround(value))) ||
    !scene.embedding.some(value => Math.fround(value) !== 0)) throw new Error('Invalid scene embedding');
}

export function sceneEvidenceType(scene: Pick<SceneEmbedding, 'evidenceType'>): 'transcript' | 'visual' {
  return scene.evidenceType ?? 'transcript';
}

/** Preserve exact JSON order and raw numbers; float32 validation never rounds
 * the canonical identity of an immutable vector version. */
export function canonicalSceneVectorInput(runId: string, scene: SceneEmbedding): string {
  return JSON.stringify([runId, scene.id, scene.content, scene.startTime, scene.endTime, sceneEvidenceType(scene), scene.embedding]);
}

export interface SceneIndexLogic<Predicate> { and(...terms: Predicate[]): Predicate }

export function sceneRunCurrent<P>(facts: { owner: P; source: P; head: P }, logic: SceneIndexLogic<P>): P {
  return logic.and(facts.owner, facts.source, facts.head);
}
export function sceneStageAllowed<P>(current: P, staging: P, logic: SceneIndexLogic<P>): P {
  return logic.and(current, staging);
}
export function scenePublishAllowed<P>(current: P, staging: P, complete: P, logic: SceneIndexLogic<P>): P {
  return logic.and(current, staging, complete);
}
export function sceneFinishAllowed<P>(indexing: P, publishedCurrentSource: P, vectorsReady: P, logic: SceneIndexLogic<P>): P {
  return logic.and(indexing, publishedCurrentSource, vectorsReady);
}

export function sceneIndexCompletionOutcome(row: { status: string; published: boolean } | undefined): FinishSceneIndexResult {
  if (!row || !['indexing', 'completed'].includes(row.status)) return 'stale';
  if (row.status === 'completed') return 'completed';
  return row.published ? 'pending' : 'missing';
}
