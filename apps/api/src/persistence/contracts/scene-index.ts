export type SceneEmbedding = {
  id: string;
  content: string;
  startTime: string;
  endTime: string;
  evidenceType?: "transcript" | "visual";
  embedding: number[];
};
export type SceneIndexRunInput = {
  runId: string;
  videoId: number;
  userId: string;
  sourceRevision: string;
  dimensions: 768 | 1536;
  expectedScenes: number;
};
export type SceneIndexSource = {
  videoId: number;
  userId: string;
  sourceRevision: string;
  fileKey: string;
  transcript: string;
  status: string;
};
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
  leaseToken: string;
};
export interface SceneIndexTaskRepository {
  claim(): Promise<SceneIndexTask | null>;
  isDesired(taskId: string): Promise<boolean>;
  complete(task: SceneIndexTask): Promise<boolean>;
  retry(task: SceneIndexTask, code: "VECTORIZE_BINDING_MISSING" | "VECTORIZE_WRITE_FAILED"): Promise<boolean>;
  reconcileObsolete(limit?: number): Promise<number>;
}

/** Verification is paced independently of write retries and propagation delay. */
export const SCENE_INDEX_VERIFY_INTERVAL_MS = 60 * 60 * 1000;

export type FinishSceneIndexInput = {
  videoId: number;
  userId: string;
  sourceRevision: string;
  fileKey: string;
  dimensions: 768 | 1536;
};
export type FinishSceneIndexResult = "completed" | "pending" | "missing" | "stale";
