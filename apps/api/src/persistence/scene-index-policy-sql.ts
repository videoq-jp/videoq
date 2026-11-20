import type { SceneIndexLogic } from '../application/scene-index-policy';

export const sceneIndexStringLogic: SceneIndexLogic<string> = {
  and: (...terms) => `(${terms.map(term => `(${term})`).join(' AND ')})`,
};
