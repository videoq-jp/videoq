import { createD1VideoMutationRepository } from "../../src/persistence/d1/video-mutation-repository";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createD1Fixture } from "./d1-fixture";
import { createD1SceneIndexWriter } from "../../src/persistence/d1/scene-index-writer";
import { createD1VideoUploadRepository } from "../../src/persistence/d1/video-upload-repository";
import { updateVideo, deleteVideoCascade } from "../../src/repositories/video-repository";
import { buildPendingUploadFileKey } from "../../src/lib/upload";
import type { Bindings } from "../../src/types/bindings";
import type { SceneEmbedding } from "../../src/persistence/contracts/scene-index";

let fixture: Awaited<ReturnType<typeof createD1Fixture>>;
let writer: ReturnType<typeof createD1SceneIndexWriter>;
let env: Bindings;
let videoId: number;
let revision: string;
const scene = (id = "scene", dimensions = 1536): SceneEmbedding => ({ id, content: `Content ${id}`, startTime: "00:00:01", endTime: "00:00:02", embedding: Array.from({ length: dimensions }, () => 0.25) });
beforeEach(async () => {
  fixture = await createD1Fixture();
  env = { DB: fixture.database, DEPLOYMENT_EDITION: "cloud" } as Bindings;
  await fixture.database.prepare(`INSERT INTO users(id,username,email,is_over_quota,used_ai_answers,used_processing_seconds,used_storage_bytes)
    VALUES ('owner','owner','owner@example.test',0,0,0,0)`).run();
  const result = await createD1VideoUploadRepository(fixture.database).reserveUpload({ userId: "owner", storageBytes: 5,
    fileKey: buildPendingUploadFileKey("owner", 5, ".mp4"), title: "Lesson", description: "" });
  if (!("ok" in result)) throw new Error("Fixture upload failed");
  videoId = result.videoId;
  await fixture.database.prepare("UPDATE videos SET status='completed',transcript='Original' WHERE id=?").bind(videoId).run();
  writer = createD1SceneIndexWriter(fixture.database);
  revision = (await writer.readSource(videoId, "owner"))!.sourceRevision;
}, 20_000);
afterEach(async () => { await fixture?.dispose(); });
const start = (runId: string, expectedScenes = 1, dimensions: 768 | 1536 = 1536) => writer.start({ runId, expectedScenes, dimensions, videoId, userId: "owner", sourceRevision: revision });
const count = async (table: string) => await fixture.database.prepare(`SELECT count(*) AS count FROM ${table}`).first<number>("count");
const publishOne = async (runId = "run", dimensions: 768 | 1536 = 1536) => {
  expect(await start(runId, 1, dimensions)).toBe(true);
  expect(await writer.stage(runId, "owner", [scene("scene", dimensions)])).toBe(true);
  expect(await writer.publish(runId, "owner")).toBe(true);
};

describe("D1 staged scene publication and video mutation fences", () => {
  it("publishes a long video only after all retryable chunks are staged", async () => {
    expect(await start("long", 42)).toBe(true);
    for (let index = 0; index < 3; index++) {
      const chunk = Array.from({ length: 14 }, (_, offset) => scene(`scene-${index * 14 + offset}`));
      expect(await writer.stage("long", "owner", chunk)).toBe(true);
      expect(await writer.stage("long", "owner", chunk)).toBe(true);
      expect(await count("scenes")).toBe(0);
      if (index < 2) expect(await writer.publish("long", "owner")).toBe(false);
    }
    expect(await writer.publish("long", "owner")).toBe(true);
    expect(await writer.publish("long", "owner")).toBe(true);
    expect(await count("scenes")).toBe(42);
    expect(await count("scene_staging")).toBe(0);
    expect(await count("scene_index_tasks")).toBe(42);
    expect(await count("mutation_receipts")).toBe(0);
    expect(await writer.stage("long", "owner", [scene()])).toBe(false);
  });
  it("rejects foreign owners, stale sources and replayed superseded runs", async () => {
    expect(await writer.readSource(videoId, "other")).toBeNull();
    expect(await writer.start({ runId: "foreign", videoId, userId: "other", sourceRevision: revision, dimensions: 1536, expectedScenes: 1 })).toBe(false);
    expect(await start("old")).toBe(true);
    expect(await writer.stage("old", "owner", [scene()])).toBe(true);
    expect(await start("new")).toBe(true);
    expect(await start("old")).toBe(false);
    expect(await writer.stage("old", "owner", [scene()])).toBe(false);
    expect(await writer.publish("old", "owner")).toBe(false);
    expect(await writer.stage("new", "owner", [scene()])).toBe(true);
    expect(await writer.publish("new", "owner")).toBe(true);
    expect((await fixture.database.prepare("SELECT revision FROM scenes").first<{ revision: string }>())?.revision).toBe("new");
  });
  it("keeps both embedding dimensions without mixing or superseding their runs", async () => {
    await publishOne("hosted", 1536);
    await publishOne("private", 768);
    expect(await count("scenes")).toBe(2);
    expect(await writer.publish("hosted", "owner")).toBe(true);
  });
  it("invalidates published and staged content when the transcript changes", async () => {
    await publishOne();
    expect(await start("pending")).toBe(true);
    expect(await writer.stage("pending", "owner", [scene("pending")])).toBe(true);
    const result = await updateVideo(env, videoId, "owner", { transcript: "New transcript" });
    expect(result).toMatchObject({ row: { id: videoId, transcript: "New transcript", tags: "[]" }, reindexTaskId: expect.any(Number) });
    expect(await count("scenes")).toBe(0);
    expect(await count("scene_staging")).toBe(0);
    expect((await writer.readSource(videoId, "owner"))!.sourceRevision).not.toBe(revision);
    expect(await writer.stage("pending", "owner", [scene()])).toBe(false);
    expect(await writer.publish("pending", "owner")).toBe(false);
    expect(await fixture.database.prepare("SELECT count(*) AS count FROM scene_index_tasks WHERE operation='delete'").first("count")).toBe(2);
    expect(await count("mutation_receipts")).toBe(0);
  });
  it("leaves embeddings intact for metadata edits and queues transcript edits once", async () => {
    await publishOne();
    expect(await updateVideo(env, videoId, "owner", { title: "Updated" })).toMatchObject({ row: { title: "Updated" }, reindexTaskId: null });
    expect(await count("scenes")).toBe(1);
    expect((await writer.readSource(videoId, "owner"))!.sourceRevision).toBe(revision);
    const results = await Promise.all(Array.from({ length: 10 }, () => updateVideo(env, videoId, "owner", { transcript: "Changed once" })));
    expect(results.filter(result => "reindexTaskId" in result && result.reindexTaskId !== null)).toHaveLength(1);
    expect(await count("external_tasks")).toBe(1);
    expect(await updateVideo(env, videoId, "other", { title: "Foreign" })).toEqual({ notFound: true });
  });
  it("rolls back source, scene visibility and deletion tasks if the reindex outbox fails", async () => {
    await publishOne();
    await fixture.database.prepare("CREATE TRIGGER fail_outbox BEFORE INSERT ON external_tasks BEGIN SELECT RAISE(ABORT,'test outbox failure'); END").run();
    await expect(updateVideo(env, videoId, "owner", { transcript: "Rejected" })).rejects.toThrow();
    expect(await writer.readSource(videoId, "owner")).toMatchObject({ sourceRevision: revision, transcript: "Original" });
    expect(await count("scenes")).toBe(1);
    expect(await count("scene_index_tasks")).toBe(1);
    expect(await count("mutation_receipts")).toBe(0);
  });
  it("deletes visibility first and preserves durable deletion work for both indexes", async () => {
    await publishOne("hosted", 1536);
    await publishOne("private", 768);
    expect(await deleteVideoCascade(env, videoId, "other")).toEqual({ deleted: false, cleanupTaskId: null });
    expect(await deleteVideoCascade(env, videoId, "owner", { expectedStatus: "uploading" })).toEqual({ deleted: false, cleanupTaskId: null });
    const results = await Promise.all(Array.from({ length: 6 }, () => deleteVideoCascade(env, videoId, "owner")));
    expect(results.filter(result => result.deleted)).toHaveLength(1);
    for (const table of ["videos", "scenes", "scene_staging", "video_index_versions", "scene_index_runs", "video_index_heads", "mutation_receipts"]) expect(await count(table)).toBe(0);
    expect(await fixture.database.prepare("SELECT count(*) AS count FROM scene_index_tasks WHERE operation='delete'").first("count")).toBe(2);
    expect(await count("external_tasks")).toBe(1);
    expect(await writer.readSource(videoId, "owner")).toBeNull();
    expect(await writer.publish("hosted", "owner")).toBe(false);
    expect(await fixture.database.prepare("SELECT used_upload_bytes FROM users WHERE id='owner'").first("used_upload_bytes")).toBe(5);
  });
  it("refunds an unconfirmed upload's current month once and respects heartbeat changes", async () => {
    await fixture.database.prepare("UPDATE videos SET status='uploading',upload_heartbeat_at=? WHERE id=?").bind(new Date().toISOString(), videoId).run();
    expect(await deleteVideoCascade(env, videoId, "owner", { inactiveBefore: new Date(0) })).toEqual({ deleted: false, cleanupTaskId: null });
    expect((await deleteVideoCascade(env, videoId, "owner")).deleted).toBe(true);
    expect(await fixture.database.prepare("SELECT used_upload_bytes FROM users WHERE id='owner'").first("used_upload_bytes")).toBe(0);
  });
  it("retains committed work when an alarm notification fails", async () => {
    const repository = createD1VideoMutationRepository(fixture.database, () => { throw new Error("test alarm unavailable"); });
    expect(await repository.update(videoId, "owner", { transcript: "Committed" })).toMatchObject({ row: { transcript: "Committed" }, reindexTaskId: expect.any(Number) });
    expect(await count("external_tasks")).toBe(1);
    expect((await repository.delete(videoId, "owner")).deleted).toBe(true);
    expect(await count("videos")).toBe(0);
  });

});
