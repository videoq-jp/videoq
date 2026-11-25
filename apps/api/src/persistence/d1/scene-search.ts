import { assertEmbeddingFingerprint } from "../../lib/embedding-contract";
import { validateSceneSearchLimit, SceneCandidateRanking, sceneCandidateCurrent, sceneOwnerVisible } from '../../application/scene-retrieval';
import { learningVideoAllowed } from '../../application/media-eligibility';
import { mediaDrizzleLogic } from '../media-eligibility-sql';
import { sceneVisibilityDrizzleLogic } from '../scene-retrieval-policy-sql';
import type {D1Database} from "@cloudflare/workers-types";
import { langchainVectorizeBinding } from "./langchain-vectorize";
import { CloudflareVectorizeStore } from "@langchain/cloudflare";
import type { Vectorize, VectorizeVectorMetadataFilter } from "@cloudflare/workers-types";
import type { EmbeddingsInterface } from "@langchain/core/embeddings";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { createD1Connection } from "../../db/d1/connection";
import { scenes, videos, users, sceneIndexRuns } from "../../db/schema/sqlite";
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
  fingerprint?: string,
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
      validateSceneSearchLimit(limit);
      if (queryEmbedding.length !== dimensions ||
          !queryEmbedding.every(value => Number.isFinite(value) && Number.isFinite(Math.fround(value))) ||
          !queryEmbedding.some(value => Math.fround(value) !== 0)) throw new Error("Invalid query embedding");
      const selections = filters(userId, videoIds);
      if (!selections.length) return [];
      if (fingerprint) {
        for (let offset = 0; offset < videoIds.length; offset += 80) {
        const provenance = await db.selectDistinct({ fingerprint: sceneIndexRuns.embeddingFingerprint })
          .from(scenes).innerJoin(videos, eq(videos.id, scenes.videoId))
          .leftJoin(sceneIndexRuns, eq(sceneIndexRuns.id, scenes.revision))
          .where(and(eq(videos.userId, userId), inArray(scenes.videoId, videoIds.slice(offset, offset + 80)), eq(scenes.dimensions, dimensions)));
        for (const row of provenance) assertEmbeddingFingerprint(row.fingerprint, fingerprint);
        }
      }
      const candidates = new SceneCandidateRanking();
      for (const filter of selections) {
        const matches = await store.similaritySearchVectorWithScore(queryEmbedding, 50, filter);
        for (const [document, score] of matches) {
          const { scene_id: id, revision } = document.metadata;
          if (typeof id !== "string" || typeof revision !== "string" || !Number.isFinite(score)) continue;
          const vectorId = typeof document.metadata.vector_id === "string" ? document.metadata.vector_id : undefined;
          candidates.add({ score, revision, sceneId: id, vectorId });
        }
      }
      const allowedVideos = new Set(videoIds);
      const ranked = candidates.ranked();
      const result = [];
      // Stay below D1's SQL bind limit, including the fixed scope parameters.
      for (let offset = 0; offset < ranked.length && result.length < limit; offset += 50) {
        const chunk = ranked.slice(offset, offset + 50);
        const rows = await db.select({
          id: scenes.id, revision: scenes.revision, vectorId: scenes.vectorId, content: scenes.content,
          videoId: scenes.videoId, videoTitle: videos.title, startTime: scenes.startTime,
          endTime: scenes.endTime, evidenceType: scenes.evidenceType,
        }).from(scenes).innerJoin(videos, eq(scenes.videoId, videos.id))
          .innerJoin(users, eq(videos.userId, users.id))
          .leftJoin(sceneIndexRuns, eq(sceneIndexRuns.id, scenes.revision)).where(and(
            fingerprint ? eq(sceneIndexRuns.embeddingFingerprint, fingerprint) : undefined,
            inArray(scenes.id, chunk.map(candidate => candidate.sceneId)), eq(scenes.dimensions, dimensions),
            sceneOwnerVisible({ mediaAllowed: learningVideoAllowed(eq(videos.userId, userId), videos.status, mediaDrizzleLogic),
              notDeactivated: isNull(users.deactivatedAt), notBanned: sql`${users.banned} IS NOT TRUE`,
              expires: sql`julianday(${users.banExpires})`, now: sql`julianday('now')` }, sceneVisibilityDrizzleLogic),
          ));
        const byId = new Map(rows.map(row => [row.id, row]));
        for (const candidate of chunk) {
          const row = byId.get(candidate.sceneId);
          if (!row || !sceneCandidateCurrent(row, candidate, allowedVideos)) continue;
          const { id: _id, revision: _revision, vectorId: _vectorId, ...hit } = row;
          result.push(hit);
          if (result.length === limit) break;
        }
      }
      return result;
    },
  };
}
