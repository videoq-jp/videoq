import type { SceneHit } from '../../application/evidence';
export type { SceneHit } from '../../application/evidence';

export interface SceneSearchRepository {
  search(params: {
    queryEmbedding: number[];
    userId: string;
    videoIds: readonly number[];
    limit: number;
  }): Promise<SceneHit[]>;
}
