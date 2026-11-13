export type SceneHit = {
  content: string;
  videoId: number;
  videoTitle: string;
  startTime: string;
  endTime: string;
  evidenceType?: "transcript" | "visual";
};

export interface SceneSearchRepository {
  search(params: {
    queryEmbedding: number[];
    userId: string;
    videoIds: readonly number[];
    limit: number;
  }): Promise<SceneHit[]>;
}
