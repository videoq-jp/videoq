import { langchainVectorizeBinding } from "./langchain-vectorize";
import { CloudflareVectorizeStore } from "@langchain/cloudflare";
import { Document } from "@langchain/core/documents";
import type { EmbeddingsInterface } from "@langchain/core/embeddings";
import type { D1Database, Vectorize } from "@cloudflare/workers-types";
import { createD1SceneIndexTaskRepository } from "./scene-index-tasks";
import { isSceneVectorQueryable } from "./scene-index-readiness";

export type SceneIndexes = { 768?: Vectorize; 1536?: Vectorize };
const noEmbeddings: EmbeddingsInterface = {
  embedQuery: () => Promise.reject(new Error("Use the shared embedding generator")),
  embedDocuments: () => Promise.reject(new Error("Index tasks must supply existing embeddings")),
};

/** Persisted retries are independent of request completion and provider availability. */
export async function synchronizeD1SceneIndex(database: D1Database, indexes: SceneIndexes, limit = 10, options: { concurrency?: number } = {}) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("Invalid index synchronization limit");
  const concurrency = options.concurrency ?? 1;
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 8) throw new Error("Invalid index synchronization concurrency");
  const tasks = createD1SceneIndexTaskRepository(database);
  const stores = new Map<number, CloudflareVectorizeStore>();
  const result = { claimed: 0, completed: 0, pending: 0, failed: 0, leaseLost: 0 };
  let requested = 0;
  const consume = async () => {
    while (requested++ < limit) {
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
          if (task.acceptedAt === null) {
            let embedding = task.embedding;
            // A pre-readiness task may already have cleared its payload. Replay
            // the exact stored vector, without calling an embedding model, so a
            // metadata index created during upgrade can index it too.
            if (embedding === null) {
              const recovered = await binding.getByIds([task.vectorId]);
              const vector = recovered.length === 1 ? recovered[0] : undefined;
              if (!vector || vector.id !== task.vectorId || vector.metadata?.user_id !== task.userId ||
                  vector.metadata?.video_id !== task.videoId || vector.metadata?.scene_id !== task.sceneId ||
                  vector.metadata?.revision !== task.revision || vector.metadata?.vector_id !== task.vectorId) throw new Error("Invalid stored vector");
              embedding = Array.from(vector.values);
            }
            if (embedding.length !== task.dimensions || !embedding.every(value => Number.isFinite(value) && Number.isFinite(Math.fround(value))) ||
                !embedding.some(value => Math.fround(value) !== 0)) throw new Error("Invalid staged embedding");
            await store.addVectors([embedding], [new Document({ pageContent: "", metadata: {
              user_id: task.userId, video_id: task.videoId, scene_id: task.sceneId, revision: task.revision, vector_id: task.vectorId,
            } })], { ids: [task.vectorId] });
          }
          // Deletion or a transcript edit may have committed while Vectorize was
          // responding. Remove that immutable version rather than reviving it.
          if (!await tasks.isDesired(task.id)) await store.delete({ ids: [task.vectorId] });
          else {
            if (task.acceptedAt === null && !await tasks.accept(task)) {
              // A replacement may have deleted the source while this write was
              // in flight. Losing the lease must not skip immutable-ID cleanup.
              if (!await tasks.isDesired(task.id)) await store.delete({ ids: [task.vectorId] });
              result.leaseLost++;
              continue;
            }
            if (!await isSceneVectorQueryable(binding, task)) {
              if (await tasks.retry(task, "VECTORIZE_NOT_READY")) result.pending++;
              else result.leaseLost++;
              continue;
            }
          }
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
  };
  // Await every worker, including when a DB operation rejects. No provider work
  // may outlive the caller or lose its persisted lease/error bookkeeping.
  const outcomes = await Promise.allSettled(Array.from({ length: Math.min(concurrency, limit) }, consume));
  const failure = outcomes.find(outcome => outcome.status === "rejected");
  if (failure?.status === "rejected") throw failure.reason;
  return result;
}
