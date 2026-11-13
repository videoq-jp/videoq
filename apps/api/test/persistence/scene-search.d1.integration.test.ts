import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Vectorize } from "@cloudflare/workers-types";
import { createD1SceneSearchRepository } from "../../src/persistence/d1/scene-search";
import { createD1Fixture } from "./d1-fixture";

const query = vi.fn();
const embedding = Array.from({ length: 1536 }, () => 0.1);
let fixture: Awaited<ReturnType<typeof createD1Fixture>>;
beforeAll(async () => {
  fixture = await createD1Fixture();
  for (const id of ["owner", "other", "inactive"]) {
    await fixture.database.prepare(`INSERT INTO users
      (id, username, email, is_over_quota, used_ai_answers, used_processing_seconds, used_storage_bytes, banned)
      VALUES (?, ?, ?, 0, 0, 0, 0, ?)`)
      .bind(id, id, `${id}@example.test`, id === "inactive" ? 1 : 0).run();
  }
  for (const [id, userId, status] of [[1, "owner", "completed"], [2, "other", "completed"], [3, "owner", "completed"], [4, "inactive", "completed"], [5, "owner", "processing"]]) {
    await fixture.database.prepare(`INSERT INTO videos
      (id,user_id,title,file,description,uploaded_at,transcript,status,error_message,source_type,source_url,youtube_video_id)
      VALUES (?, ?, ?, '', '', '2026-11-13T00:00:00.000Z', '', ?, '', 'upload', '', '')`)
      .bind(id, userId, `Title ${id}`, status).run();
    await fixture.database.prepare(`INSERT INTO scenes
      (id,video_id,content,start_time,end_time,dimensions,revision) VALUES (?, ?, ?, '00:01', '00:02', 1536, 'r1')`)
      .bind(`scene-${id}`, id, `D1 authoritative content ${id}`).run();
  }
});
afterAll(async () => { await fixture?.dispose(); });
const repository = () => createD1SceneSearchRepository(fixture.database, { query } as unknown as Vectorize, 1536);
const match = (id: string, revision = "r1", score = 0.9) => ({
  id, score, metadata: { scene_id: id, revision, text: "untrusted index text", user_id: "owner", video_id: 1 },
});

describe("D1 + LangChain Vectorize scene search", () => {
  it("revalidates owner, selection, revision, existence and visibility against D1", async () => {
    query.mockResolvedValue({ matches: [
      match("scene-2"), match("scene-3"), match("missing"), match("scene-5"),
      match("scene-1", "obsolete", 1),
    ] });
    expect(await repository().search({ queryEmbedding: embedding, userId: "owner", videoIds: [1, 2, 5], limit: 20 })).toEqual([]);
    query.mockResolvedValue({ matches: [match("scene-1")] });
    expect(await repository().search({ queryEmbedding: embedding, userId: "owner", videoIds: [1], limit: 20 })).toEqual([{
      content: "D1 authoritative content 1", videoId: 1, videoTitle: "Title 1", startTime: "00:01", endTime: "00:02", evidenceType: "transcript",
    }]);
    query.mockResolvedValue({ matches: [match("scene-4")] });
    expect(await repository().search({ queryEmbedding: embedding, userId: "inactive", videoIds: [4], limit: 20 })).toEqual([]);
  });
  it("splits large selections within filter limits and merges cosine scores", async () => {
    query.mockClear();
    query.mockResolvedValue({ matches: [match("scene-3", "r1", 0.8), match("scene-1", "r1", 0.9)] });
    const hits = await repository().search({ queryEmbedding: embedding, userId: "owner", videoIds: Array.from({ length: 1000 }, (_, i) => i + 1), limit: 1 });
    expect(hits.map(hit => hit.videoId)).toEqual([1]);
    expect(query.mock.calls.length).toBeGreaterThan(1);
    for (const [, options] of query.mock.calls) {
      expect(new TextEncoder().encode(JSON.stringify(options.filter)).length).toBeLessThan(2048);
      expect(options.filter.user_id).toBe("owner");
      expect(options.returnMetadata).toBe("all");
      expect(options.returnValues).toBe(false);
    }
  });
  it("rejects invalid dimensions and limits before querying, and skips empty selections", async () => {
    query.mockClear();
    await expect(repository().search({ queryEmbedding: [1], userId: "owner", videoIds: [1], limit: 20 })).rejects.toThrow("Invalid query embedding");
    await expect(repository().search({ queryEmbedding: embedding, userId: "owner", videoIds: [1], limit: 51 })).rejects.toThrow("Search limit");
    expect(await repository().search({ queryEmbedding: embedding, userId: "owner", videoIds: [], limit: 20 })).toEqual([]);
    expect(query).not.toHaveBeenCalled();
  });
});
