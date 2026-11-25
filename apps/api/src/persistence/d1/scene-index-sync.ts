import { assertEmbeddingFingerprint } from "../../lib/embedding-contract";
import { synchronizeSceneIndex } from '../../features/maintenance/scene-index-service';
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

/** Runtime composition; the workflow sees only leased tasks and vector capabilities. */
export async function synchronizeD1SceneIndex(database: D1Database, indexes: SceneIndexes, limit = 10, options: { concurrency?: number; fingerprint?: string } = {}) {
  const stores = new Map<number, CloudflareVectorizeStore>();
  return synchronizeSceneIndex({
    tasks: () => createD1SceneIndexTaskRepository(database),
    indexAvailable: dimensions => Boolean(indexes[dimensions]),
    connect: dimensions => {
      const binding = indexes[dimensions]!;
      let store = stores.get(dimensions);
      if (!store) {
        store = new CloudflareVectorizeStore(noEmbeddings, { index: langchainVectorizeBinding(binding) });
        stores.set(dimensions, store);
      }
      const vectors = store;
      return {
        read: vectorId => binding.getByIds([vectorId]),
        upsert: async (task, embedding) => {
          if (options.fingerprint) {
            const actual = await database.prepare("SELECT embedding_fingerprint FROM scene_index_runs WHERE id=? AND video_id=? AND user_id=? AND dimensions=?")
              .bind(task.revision, task.videoId, task.userId, task.dimensions).first<string>("embedding_fingerprint");
            assertEmbeddingFingerprint(actual, options.fingerprint);
          }
          return vectors.addVectors([embedding], [new Document({ pageContent: '', metadata: {
          user_id: task.userId, video_id: task.videoId, scene_id: task.sceneId, revision: task.revision, vector_id: task.vectorId,
        } })], { ids: [task.vectorId] });
        },
        remove: vectorId => vectors.delete({ ids: [vectorId] }),
        queryable: task => isSceneVectorQueryable(binding, task),
      };
    },
  }, limit, options);
}
