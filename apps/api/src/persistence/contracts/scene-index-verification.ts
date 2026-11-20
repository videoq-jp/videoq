export type SceneVectorVerificationTask = {
  id: string; vector_id: string; video_id: number; user_id: string; scene_id: string;
  revision: string; legacy_replay: number; source_revision: string;
};
export type SceneVectorIdentity = { id: string; metadata?: Record<string, unknown> };
export interface SceneIndexVerificationRepository {
  due(dimensions: 768 | 1536, limit: number): Promise<SceneVectorVerificationTask[]>;
  enqueueRepair(input: { dimensions: 768 | 1536; videoId: number; missingVectorIds: string[]; dedupeKey: string }): Promise<number>;
  markVerified(taskIds: string[]): Promise<void>;
}
