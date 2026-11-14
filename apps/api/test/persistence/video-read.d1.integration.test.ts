import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createD1Fixture } from "./d1-fixture";
import { createD1VideoUploadRepository } from "../../src/persistence/d1/video-upload-repository";
import { getVideoDetail, getVideoMetadata, countVideosByStatus, listVideosPage, listStaleUploadingVideos } from "../../src/repositories/video-repository";
import type { Bindings } from "../../src/types/bindings";

let fixture: Awaited<ReturnType<typeof createD1Fixture>>;
let env: Bindings;
const ids: number[] = [];
const transcript = "字幕😀𐀀";
const criteria = { keyword: "", statusFilter: "", sortKey: "title_asc", tagIds: null };
beforeAll(async () => {
  fixture = await createD1Fixture();
  const db = fixture.database;
  env = { DEPLOYMENT_EDITION: "cloud", DB: db } as Bindings;
  for (const userId of ["owner", "other"]) {
    await db.prepare(`INSERT INTO users (id,username,email,is_over_quota,used_ai_answers,used_processing_seconds,used_storage_bytes)
      VALUES (?,?,?,0,0,0,0)`).bind(userId, userId, `${userId}@example.test`).run();
  }
  const repo = createD1VideoUploadRepository(db);
  for (const [index, title] of ["100% café_", "CAFÉ_ lesson", "Stale", "Heartbeat", "Hidden"].entries()) {
    const result = await repo.reserveUpload({ userId: index === 4 ? "other" : "owner", storageBytes: 1, fileKey: `videos/${index}.mp4`, title, description: "日本語" });
    if (!("ok" in result)) throw new Error("Fixture admission failed");
    ids.push(result.videoId);
  }
  await db.prepare("UPDATE videos SET status='completed',transcript=? WHERE id=?").bind(transcript, ids[0]).run();
  await db.prepare("UPDATE videos SET status='pending' WHERE id=?").bind(ids[1]).run();
  await db.prepare("UPDATE videos SET uploaded_at='2000-01-01T00:00:00.000Z' WHERE id IN (?,?)").bind(ids[2], ids[3]).run();
  await db.prepare("UPDATE videos SET upload_heartbeat_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?").bind(ids[3]).run();
  await db.prepare("INSERT INTO tags (id,user_id,name,color,created_at) VALUES (1,'owner','Zeta','#123456',?), (2,'owner','Alpha','#abcdef',?)").bind(new Date().toISOString(), new Date().toISOString()).run();
  await db.prepare("INSERT INTO video_tags (video_id,tag_id,added_at) VALUES (?,1,?), (?,2,?)").bind(ids[0], new Date().toISOString(), ids[0], new Date().toISOString()).run();
  await db.prepare(`INSERT INTO video_visual_runs (video_id,run_id,file_key,duration_ms,chunk_count,status)
    VALUES (?,'visual-run','videos/0.mp4',1000,2,'processing')`).bind(ids[0]).run();
  await db.prepare("INSERT INTO video_visual_chunks (run_id,chunk_index,frame_count) VALUES ('visual-run',0,1),('visual-run',1,NULL)").run();
}, 20_000);
afterAll(async () => { await fixture?.dispose(); });

describe("D1 video reads through the application facade", () => {
  it("normalizes tags, visual progress, metadata and UTF-16 transcript offsets", async () => {
    const detail = await getVideoDetail(env, ids[0], "owner", { includeFileUrl: false });
    expect(detail).toMatchObject({ id: ids[0], transcript, file: null, user: "owner", visual_processing: { status: "processing", total_chunks: 2, completed_chunks: 1 } });
    expect(detail?.tags.map(tag => tag.name)).toEqual(["Alpha", "Zeta"]);
    const metadata = await getVideoMetadata(env, ids[0], "owner");
    expect(metadata).toMatchObject({ file: null, transcript_available: true, transcript_total_chars: transcript.length });
    expect(metadata).not.toHaveProperty("transcript");
    expect(await getVideoDetail(env, ids[0], "other")).toBeNull();
    expect(await getVideoMetadata(env, ids[4], "owner")).toBeNull();
  });
  it("keeps literal substring and Unicode case matching, paging and tag/status scopes", async () => {
    const page = (patch: Partial<typeof criteria>, limit = 10, offset = 0) => listVideosPage(env, "owner", { ...criteria, ...patch }, limit, offset, { includeFileUrls: false });
    expect((await page({ keyword: "%" })).results.map(row => row.id)).toEqual([ids[0]]);
    expect((await page({ keyword: "café_" })).count).toBe(2);
    expect((await page({ keyword: "日本語" })).count).toBe(4);
    expect((await page({ keyword: "日本語" }, 1, 1)).results).toHaveLength(1);
    expect((await page({ statusFilter: "completed,pending" })).count).toBe(2);
    const tagged = await listVideosPage(env, "owner", { ...criteria, tagIds: [1] }, 10, 0, { includeFileUrls: false });
    expect(tagged.results.map(row => row.id)).toEqual([ids[0]]);
    expect((await page({}, 10, 100)).results).toEqual([]);
  });
  it("counts owner statuses and protects live upload heartbeats from stale cleanup", async () => {
    expect(await countVideosByStatus(env, "owner")).toEqual({ total: 4, completed: 1, pending: 1, processing: 0, indexing: 0, error: 0, uploading: 2 });
    expect((await listStaleUploadingVideos(env, 1)).map(video => video.id)).toEqual([ids[2]]);
  });
});
