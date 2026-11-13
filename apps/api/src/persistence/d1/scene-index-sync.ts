import { langchainVectorizeBinding } from "./langchain-vectorize";
import { CloudflareVectorizeStore } from "@langchain/cloudflare";
import { Document } from "@langchain/core/documents";
import type { EmbeddingsInterface } from "@langchain/core/embeddings";
import type { D1Database, Vectorize } from "@cloudflare/workers-types";
import { createD1SceneIndexTaskRepository } from "./scene-index-tasks";

export type SceneIndexes = { 768?: Vectorize; 1536?: Vectorize };
const noEmbeddings: EmbeddingsInterface = {
  embedQuery: () => Promise.reject(new Error("Use the shared embedding generator")),
  embedDocuments: () => Promise.reject(new Error("Index tasks must supply existing embeddings")),
};

/** Persisted retries are independent of request completion and provider availability. */
export async function synchronizeD1SceneIndex(database: D1Database, indexes: SceneIndexes, limit = 10) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("Invalid index synchronization limit");
  const tasks = createD1SceneIndexTaskRepository(database);
  const stores = new Map<number, CloudflareVectorizeStore>();
  const result = { claimed: 0, completed: 0, failed: 0, leaseLost: 0 };
  for (let index = 0; index < limit; index++) {
    const task = await tasks.claim();
    if (!task) break;
    result.claimed++;
    const binding = indexes[task.dimensions];
    if (!binding) {
      if (await tasks.retry(task, "VECTORIZE_BINDING_MISSING")) result.failed++;
      else result.leaseLost++;
      continue;
    }
    try {
      let store = stores.get(task.dimensions);
      if (!store) { store = new CloudflareVectorizeStore(noEmbeddings, { index: langchainVectorizeBinding(binding) }); stores.set(task.dimensions, store); }
      const desired = await tasks.isDesired(task.id);
      if (task.operation === "upsert" && desired) {
        if (!task.embedding || task.embedding.length !== task.dimensions) throw new Error("Invalid staged embedding");
        await store.addVectors([task.embedding], [new Document({ pageContent: "", metadata: {
          user_id: task.userId, video_id: task.videoId, scene_id: task.sceneId, revision: task.revision, vector_id: task.vectorId,
        } })], { ids: [task.vectorId] });
        // Deletion or a transcript edit may have committed while Vectorize was
        // responding. Remove that immutable version rather than reviving it.
        if (!await tasks.isDesired(task.id)) await store.delete({ ids: [task.vectorId] });
      } else if (!desired) {
        await store.delete({ ids: [task.vectorId] });
      }
      if (await tasks.complete(task)) result.completed++;
      else result.leaseLost++;
    } catch {
      // Raw provider errors can contain credentials or request payloads.
      if (await tasks.retry(task, "VECTORIZE_WRITE_FAILED")) result.failed++;
      else result.leaseLost++;
    }
  }
  return result;
}
