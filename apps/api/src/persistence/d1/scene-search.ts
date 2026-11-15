import type {D1Database} from "@cloudflare/workers-types";
import { langchainVectorizeBinding } from "./langchain-vectorize";
import { CloudflareVectorizeStore } from "@langchain/cloudflare";
import type { Vectorize, VectorizeVectorMetadataFilter } from "@cloudflare/workers-types";
import type { EmbeddingsInterface } from "@langchain/core/embeddings";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { createD1Connection } from "../../db/d1/connection";
import { scenes, videos, users } from "../../db/schema/sqlite";
import type { SceneSearchRepository } from "../contracts/scene-search";

/** Split large course selections by the serialized filter size, preserving scope. */
function filters(userId: string, videoIds: readonly number[]): VectorizeVectorMetadataFilter[] {
  const result: VectorizeVectorMetadataFilter[] = [];
  let ids: number[] = [];
  const filter = (values: number[]) => ({ user_id: userId, video_id: { $in: values } });
  const bytes = (values: number[]) => new TextEncoder().encode(JSON.stringify(filter(values))).length;
  for (const id of new Set(videoIds)) {
    if (!Number.isSafeInteger(id) || id <= 0) throw new Error("Invalid video ID");
    if (bytes([...ids, id]) >= 2048) {
      if (!ids.length) throw new Error("Vectorize scope exceeds the metadata filter size limit");
      result.push(filter(ids));
      ids = [];
    }
    ids.push(id);
    if (bytes(ids) >= 2048) throw new Error("Vectorize scope exceeds the metadata filter size limit");
  }
  if (ids.length) result.push(filter(ids));
  return result;
}

export function createD1SceneSearchRepository(
  database: D1Database,
  index: Vectorize,
  dimensions: 768 | 1536,
): SceneSearchRepository {
  const db = createD1Connection(database);
  // Search receives an already-generated embedding; never change the existing model.
  const embeddings: EmbeddingsInterface = {
    embedQuery: () => Promise.reject(new Error("Use the shared embedding generator")),
    embedDocuments: () => Promise.reject(new Error("Use the scene index synchronizer")),
  };
  const store = new CloudflareVectorizeStore(embeddings, { index: langchainVectorizeBinding(index) });
  return {
    async search({ queryEmbedding, userId, videoIds, limit }) {
      if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new Error("Search limit must be between 1 and 50");
      if (queryEmbedding.length !== dimensions ||
          !queryEmbedding.every(value => Number.isFinite(value) && Number.isFinite(Math.fround(value))) ||
          !queryEmbedding.some(value => Math.fround(value) !== 0)) throw new Error("Invalid query embedding");
      const selections = filters(userId, videoIds);
      if (!selections.length) return [];
      const candidates = new Map<string, { score: number; revision: string; sceneId: string; vectorId?: string }>();
      for (const filter of selections) {
        const matches = await store.similaritySearchVectorWithScore(queryEmbedding, 50, filter);
        for (const [document, score] of matches) {
          const { scene_id: id, revision } = document.metadata;
          if (typeof id !== "string" || typeof revision !== "string" || !Number.isFinite(score)) continue;
          const vectorId = typeof document.metadata.vector_id === "string" ? document.metadata.vector_id : undefined;
          const key = vectorId ?? `legacy:${id}:${revision}`;
          if (!candidates.has(key) || score > candidates.get(key)!.score) candidates.set(key, { score, revision, sceneId: id, vectorId });
        }
      }
      const allowedVideos = new Set(videoIds);
      const ranked = [...candidates].sort((a, b) => b[1].score - a[1].score || a[0].localeCompare(b[0]));
      const result = [];
      // Stay below D1's SQL bind limit, including the fixed scope parameters.
      for (let offset = 0; offset < ranked.length && result.length < limit; offset += 50) {
        const chunk = ranked.slice(offset, offset + 50);
        const rows = await db.select({
          id: scenes.id, revision: scenes.revision, vectorId: scenes.vectorId, content: scenes.content,
          videoId: scenes.videoId, videoTitle: videos.title, startTime: scenes.startTime,
          endTime: scenes.endTime, evidenceType: scenes.evidenceType,
        }).from(scenes).innerJoin(videos, eq(scenes.videoId, videos.id))
          .innerJoin(users, eq(videos.userId, users.id)).where(and(
            inArray(scenes.id, chunk.map(([, candidate]) => candidate.sceneId)), eq(scenes.dimensions, dimensions),
            eq(videos.userId, userId), eq(videos.status, "completed"),
            isNull(users.deactivatedAt),
            sql`(${users.banned} IS NOT TRUE OR julianday(${users.banExpires}) < julianday('now'))`,
          ));
        const byId = new Map(rows.map(row => [row.id, row]));
        for (const [, candidate] of chunk) {
          const row = byId.get(candidate.sceneId);
          if (!row || row.revision !== candidate.revision || !allowedVideos.has(row.videoId)) continue;
          if (row.vectorId !== null ? row.vectorId !== candidate.vectorId : candidate.vectorId !== undefined && candidate.vectorId !== row.id) continue;
          const { id: _id, revision: _revision, vectorId: _vectorId, ...hit } = row;
          result.push(hit);
          if (result.length === limit) break;
        }
      }
      return result;
    },
  };
}
