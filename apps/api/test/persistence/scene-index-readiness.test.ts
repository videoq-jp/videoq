import { describe, expect, it, vi } from "vitest";
import type { Vectorize } from "@cloudflare/workers-types";
import type { SceneIndexTask } from "../../src/persistence/contracts/scene-index";
import { isSceneVectorQueryable } from "../../src/persistence/d1/scene-index-readiness";

const task: SceneIndexTask = { id: "task", operation: "upsert", vectorId: "a".repeat(64), sceneId: "scene", revision: "run",
  videoId: 1, userId: "owner", dimensions: 1536, embedding: null, acceptedAt: "2026-11-15T00:00:00Z", leaseToken: "lease" };
const valid = () => ({ id: task.vectorId, score: 1, metadata: {
  user_id: task.userId, video_id: task.videoId, scene_id: task.sceneId, revision: task.revision, vector_id: task.vectorId,
} });
const binding = (queryById: unknown) => ({ queryById }) as Pick<Vectorize, "queryById">;
describe("exact physical-vector ANN readiness", () => {
  it("requires an exact scoped ANN hit without retrieving embeddings", async () => {
    const query = vi.fn(async () => ({ matches: [valid()] }));
    expect(await isSceneVectorQueryable(binding(query), task)).toBe(true);
    expect(query).toHaveBeenCalledWith(task.vectorId, { topK: 1, returnValues: false, returnMetadata: "all",
      filter: { user_id: "owner", video_id: 1, vector_id: task.vectorId } });
  });
  it("keeps empty, malformed and forged provider responses pending", async () => {
    for (const response of [
      { matches: [] }, { matches: [valid(), valid()] },
      { matches: [{ ...valid(), id: "forged-physical-id" }] },
      { matches: [{ ...valid(), score: NaN }] },
      ...Object.entries({ user_id: "other", video_id: 2, scene_id: "other", revision: "old", vector_id: "forged" })
        .map(([key, value]) => ({ matches: [{ ...valid(), metadata: { ...valid().metadata, [key]: value } }] })),
    ]) expect(await isSceneVectorQueryable(binding(async () => response), task)).toBe(false);
  });
  it("never treats a provider exception as readiness or emits its diagnostic", async () => {
    const log = vi.spyOn(console, "error");
    try {
      expect(await isSceneVectorQueryable(binding(async () => { throw Error("synthetic-private-provider-payload"); }), task)).toBe(false);
      expect(log).not.toHaveBeenCalled();
    } finally { log.mockRestore(); }
  });
  it("rejects an oversized scope before contacting the provider", async () => {
    const query = vi.fn();
    expect(await isSceneVectorQueryable(binding(query), { ...task, userId: "界".repeat(1000) })).toBe(false);
    expect(query).not.toHaveBeenCalled();
  });
});
