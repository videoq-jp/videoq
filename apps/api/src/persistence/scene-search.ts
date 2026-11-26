import { DEFAULT_SCENE_SEARCH_RESULTS, sceneSearchSelection } from '../application/scene-retrieval';
import type { Bindings } from "../types/bindings";
import type { UsageRecorder } from "../tools/usage";
import type { SceneHit } from "./contracts/scene-search";
import { persistenceBackend } from "./backend";
import { embedQuery } from "../lib/embeddings";
import { embeddingFingerprint, embeddingDimensions, resolveEmbeddingConfig } from "../lib/embedding-contract";

export type { SceneHit } from "./contracts/scene-search";
export type SceneSearch = {
  search(query: string, videoIds?: readonly number[], callSignal?: AbortSignal): Promise<SceneHit[]>;
  close(): Promise<void>;
};

export async function openSceneSearch(
  env: Bindings,
  params: { userId: string; videoIds: readonly number[] },
  signal?: AbortSignal,
  costLedger?: UsageRecorder,
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
  const repository = createD1SceneSearchRepository(env.DB, index, dimensions, await embeddingFingerprint(config));
  const allowed = new Set(params.videoIds);
  return {
    async search(query, videoIds, callSignal) {
      const executionSignal = callSignal && signal ? AbortSignal.any([callSignal, signal]) : callSignal ?? signal;
      executionSignal?.throwIfAborted();
      const selected = sceneSearchSelection(allowed, videoIds);
      if (!selected.length) return [];
      const queryEmbedding = await embedQuery(env, query, executionSignal, costLedger);
      executionSignal?.throwIfAborted();
      const hits = await repository.search({ queryEmbedding, userId: params.userId, videoIds: selected, limit: DEFAULT_SCENE_SEARCH_RESULTS });
      executionSignal?.throwIfAborted();
      return hits;
    },
    async close() {},
  };
}
