import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const sendSqsMessage = vi.hoisted(() => vi.fn());
vi.mock("../../src/lib/sqs", () => ({ sendSqsMessage }));
vi.mock("../../src/lib/task-scheduler", async importOriginal => ({
  ...await importOriginal<typeof import("../../src/lib/task-scheduler")>(),
  armMaintenance: () => Promise.resolve(),
}));
vi.mock("../../src/integrations/media", async importOriginal => ({
  ...await importOriginal<typeof import("../../src/integrations/media")>(),
  presignR2Put: () => Promise.resolve("https://upload.example.test/put"),
  getR2ObjectSize: () => Promise.resolve(1),
  deleteR2Object: () => Promise.resolve(),
  deleteVisualChunks: () => Promise.resolve(),
}));
import { requestPresignedUpload, confirmVideoUpload, createUserYoutubeVideo, patchUserVideo, deleteUserVideo } from "../../src/features/videos/service";
import { processExternalTaskById } from "../../src/lib/external-tasks";
import type { Bindings } from "../../src/types/bindings";
import { createD1Fixture } from "./d1-fixture";

let fixture: Awaited<ReturnType<typeof createD1Fixture>>;
let env: Bindings;
beforeEach(async () => {
  fixture = await createD1Fixture();
  env = { DB: fixture.database, DEPLOYMENT_EDITION: "cloud", ENVIRONMENT: "production", USE_S3_STORAGE: "true" } as Bindings;
  sendSqsMessage.mockReset().mockResolvedValue("test-sqs-id");
  await fixture.database.prepare(`INSERT INTO users(id,username,email,is_over_quota,used_ai_answers,used_processing_seconds,used_storage_bytes)
    VALUES ('owner','owner','owner@example.test',0,0,0,0)`).run();
}, 20_000);
afterEach(async () => { await fixture?.dispose(); });
const requestUpload = () => requestPresignedUpload(env, "owner", { filename: "lesson.mp4", content_type: "video/mp4", file_size: 1, title: "Lesson", description: "" });

describe("D1 video service pipeline", () => {
  it("registers, confirms, delivers and reads a video using only D1 persistence", async () => {
    const uploaded = await requestUpload();
    expect(uploaded).toMatchObject({ upload_url: "https://upload.example.test/put", video: { status: "uploading", title: "Lesson" } });
    if (!("video" in uploaded) || !uploaded.video) throw new Error("Upload failed");
    const confirmed = await confirmVideoUpload(env, uploaded.video.id, "owner");
    expect(confirmed).toMatchObject({ video: { id: uploaded.video.id, status: "pending" }, alreadyConfirmed: false });
    expect(sendSqsMessage).toHaveBeenCalledTimes(1);
    const message = JSON.parse(sendSqsMessage.mock.calls[0][1] as string);
    expect(message).toMatchObject({ type: "transcribe_video", payload: { video_id: uploaded.video.id } });
    expect(await confirmVideoUpload(env, uploaded.video.id, "owner")).toMatchObject({ alreadyConfirmed: true });
    expect(sendSqsMessage).toHaveBeenCalledTimes(1);
    expect(await fixture.database.prepare("SELECT count(*) AS count FROM external_tasks WHERE completed_at IS NOT NULL").first("count")).toBe(1);
    expect(await fixture.database.prepare("SELECT used_upload_bytes FROM users WHERE id='owner'").first("used_upload_bytes")).toBe(1);
  });
  it("registers and dispatches an idempotent YouTube import", async () => {
    const idempotency = { action: "create_youtube_video" as const, key: "youtube-retry", requestHash: "a".repeat(64) };
    const body = { youtube_url: "https://www.youtube.com/watch?v=abcdefghijk", title: "YouTube", description: "" };
    const created = await createUserYoutubeVideo(env, "owner", body, idempotency);
    const replay = await createUserYoutubeVideo(env, "owner", body, idempotency);
    expect(created).toMatchObject({ reused: false, video: { status: "pending", source_type: "youtube", title: "YouTube" } });
    expect(replay).toMatchObject({ reused: true });
    expect(sendSqsMessage).toHaveBeenCalledTimes(1);
  });
  it("retains failed deliveries for retry without undoing confirmed state", async () => {
    const uploaded = await requestUpload();
    if (!("video" in uploaded) || !uploaded.video) throw new Error("Upload failed");
    sendSqsMessage.mockRejectedValueOnce(new Error("test delivery failure"));
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(await confirmVideoUpload(env, uploaded.video.id, "owner")).toMatchObject({ video: { status: "pending" } });
      const task = await fixture.database.prepare("SELECT id,completed_at,attempts FROM external_tasks").first<{ id: number; completed_at: string | null; attempts: number }>();
      expect(task).toMatchObject({ completed_at: null, attempts: 1 });
      await fixture.database.prepare("UPDATE external_tasks SET available_at='2000-01-01T00:00:00.000Z' WHERE id=?").bind(task!.id).run();
      expect(await processExternalTaskById(env, task!.id)).toBe(true);
      expect(sendSqsMessage).toHaveBeenCalledTimes(2);
    } finally { log.mockRestore(); }
  });
  it("patches and deletes through the D1 service path with safe quota release", async () => {
    const uploaded = await requestUpload();
    if (!("video" in uploaded) || !uploaded.video) throw new Error("Upload failed");
    const videoId = uploaded.video.id;
    expect(await patchUserVideo(env, videoId, "owner", { transcript: "invalid SRT" })).toHaveProperty("fieldError");
    expect(await patchUserVideo(env, videoId, "other", { transcript: "invalid SRT" })).toEqual({ notFound: true });
    const transcript = "1\n00:00:00,000 --> 00:00:01,000\nUpdated";
    expect(await patchUserVideo(env, videoId, "owner", { transcript })).toMatchObject({ video: { id: videoId, transcript } });
    expect(await deleteUserVideo(env, videoId, "owner")).toEqual({ ok: true });
    expect(await fixture.database.prepare("SELECT used_storage_bytes FROM users WHERE id='owner'").first("used_storage_bytes")).toBe(0);
    expect(await fixture.database.prepare("SELECT used_upload_bytes FROM users WHERE id='owner'").first("used_upload_bytes")).toBe(0);
    expect(await deleteUserVideo(env, videoId, "owner")).toEqual({ notFound: true });
  });

});
