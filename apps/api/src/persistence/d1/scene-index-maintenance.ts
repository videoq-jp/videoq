import { createD1SceneIndexTaskRepository } from "./scene-index-tasks";
import { synchronizeD1SceneIndex, type SceneIndexes } from "./scene-index-sync";
import { reconcileMissingSceneVectors } from "./scene-index-reconciliation";

export async function maintainD1SceneIndex(database: D1Database, indexes: SceneIndexes, activeDimensions: 768 | 1536 = 1536) {
  const reconciled = await createD1SceneIndexTaskRepository(database).reconcileObsolete();
  const result = await synchronizeD1SceneIndex(database, indexes);
  const index = indexes[activeDimensions];
  const verification = index ? await reconcileMissingSceneVectors(database, index, activeDimensions) : { verified: 0, repairQueued: 0 };
  return { ...result, reconciled, ...verification };
}
