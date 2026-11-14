import type { Bindings } from "../types/bindings";
import type { AnswerCostLedger } from "../lib/answer-cost-ledger";
import type { SceneHit } from "./contracts/scene-search";
import { persistenceBackend } from "./backend";
import { embedQuery } from "../lib/embeddings";
import { embeddingDimensions, resolveEmbeddingConfig } from "../lib/embedding-contract";

export type { SceneHit } from "./contracts/scene-search";
export type SceneSearch = {
  search(query: string, videoIds?: readonly number[]): Promise<SceneHit[]>;
  close(): Promise<void>;
};

export async function openSceneSearch(
  env: Bindings,
  params: { userId: string; videoIds: readonly number[] },
  signal?: AbortSignal,
  costLedger?: AnswerCostLedger,
): Promise<SceneSearch> {
  signal?.throwIfAborted();
  if (persistenceBackend(env) === "postgres") {
    const { openPostgresSceneSearch } = await import("./postgres/scene-search");
    return openPostgresSceneSearch(env, params, signal, costLedger);
  }
  if (!env.DB) throw new Error("D1 DB binding is required");
  const config = resolveEmbeddingConfig(env);
  const dimensions = embeddingDimensions(config) as 768 | 1536;
  const index = dimensions === 768 ? env.SCENE_VECTORIZE_768 : env.SCENE_VECTORIZE_1536;
  if (!index) throw new Error(`Vectorize ${dimensions} binding is required`);
  const { createD1SceneSearchRepository } = await import("./d1/scene-search");
  const repository = createD1SceneSearchRepository(env.DB, index, dimensions);
  const allowed = new Set(params.videoIds);
  return {
    async search(query, videoIds) {
      signal?.throwIfAborted();
      if (videoIds !== undefined && (!videoIds.length || videoIds.some(id => !allowed.has(id)))) {
        throw new Error("Video selection must be a non-empty subset of the current course.");
      }
      const selected = videoIds === undefined ? [...allowed] : [...new Set(videoIds)];
      if (!selected.length) return [];
      const queryEmbedding = await embedQuery(env, query, signal, costLedger);
      signal?.throwIfAborted();
      const hits = await repository.search({ queryEmbedding, userId: params.userId, videoIds: selected, limit: 20 });
      signal?.throwIfAborted();
      return hits;
    },
    async close() {},
  };
}
