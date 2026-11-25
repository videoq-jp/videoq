import type { SceneEmbedding, SceneIndexRunInput, SceneIndexSource } from '../../application/scene-index-policy';
export type { SceneEmbedding, SceneIndexRunInput, SceneIndexSource, FinishSceneIndexInput, FinishSceneIndexResult } from '../../application/scene-index-policy';
export interface SceneIndexWriter {
  readSource(videoId: number, userId: string): Promise<SceneIndexSource | null>;
  start(input: SceneIndexRunInput): Promise<boolean>;
  stage(runId: string, userId: string, scenes: readonly SceneEmbedding[]): Promise<boolean>;
  publish(runId: string, userId: string): Promise<boolean>;
}

export type SceneIndexTask = {
  id: string;
  operation: "upsert" | "delete";
  vectorId: string;
  sceneId: string;
  revision: string;
  videoId: number;
  userId: string;
  dimensions: 768 | 1536;
  embedding: number[] | null;
  acceptedAt: string | null;
  leaseToken: string;
};
export interface SceneIndexTaskRepository {
  claim(options?: { prefer?: "delivery" | "readiness" | "cleanup" }): Promise<SceneIndexTask | null>;
  isDesired(taskId: string): Promise<boolean>;
  accept(task: SceneIndexTask): Promise<boolean>;
  complete(task: SceneIndexTask): Promise<boolean>;
  retry(task: SceneIndexTask, code: "VECTORIZE_BINDING_MISSING" | "VECTORIZE_WRITE_FAILED" | "VECTORIZE_NOT_READY"): Promise<boolean>;
  reconcileObsolete(limit?: number): Promise<number>;
}

/** Verification is paced independently of write retries and propagation delay. */
export const SCENE_INDEX_VERIFY_INTERVAL_MS = 60 * 60 * 1000;
