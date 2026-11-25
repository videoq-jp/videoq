import { createD1SceneIndexTaskRepository } from "./scene-index-tasks";
import { synchronizeD1SceneIndex, type SceneIndexes } from "./scene-index-sync";
import { reconcileMissingSceneVectors } from "./scene-index-reconciliation";

export async function maintainD1SceneIndex(database: D1Database, indexes: SceneIndexes, activeDimensions: 768 | 1536 = 1536) {
  const reconciled = await createD1SceneIndexTaskRepository(database).reconcileObsolete();
  // A single shared scheduler must drain bulk imports without serializing all
  // provider round trips. Keep both the page and in-flight work bounded; the
  // atomic task claim still fences concurrent workers and expired leases.
  const result = await synchronizeD1SceneIndex(database, indexes, 80, { concurrency: 8 });
  const index = indexes[activeDimensions];
  const verification = index ? await reconcileMissingSceneVectors(database, index, activeDimensions) : { verified: 0, repairQueued: 0 };
  return { ...result, reconciled, ...verification };
}
