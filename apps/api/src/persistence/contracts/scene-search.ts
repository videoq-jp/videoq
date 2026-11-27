import type { SceneHit } from '../../domain/conversation/evidence';
export type { SceneHit } from '../../domain/conversation/evidence';

export interface SceneSearchRepository {
  search(params: {
    queryEmbedding: number[];
    userId: string;
    videoIds: readonly number[];
    limit: number;
  }): Promise<SceneHit[]>;
}
