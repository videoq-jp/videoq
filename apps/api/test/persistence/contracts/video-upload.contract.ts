import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { VideoUploadRepository } from "../../../src/persistence/contracts/video-upload-repository";
import type { CreationIdempotency } from "../../../src/persistence/contracts/creation-idempotency";

export interface VideoUploadFixture {
  repository: VideoUploadRepository;
  seedOwner(options?: { storageLimit?: number | null; monthlyLimit?: number | null; staleMonth?: boolean }): Promise<void>;
  blockOwner(): Promise<void>;
  failOutbox(): Promise<void>;
  snapshot(): Promise<{
    storageBytes: number; uploadBytes: number; receiptCount: number;
    videos: { id: number; status: string }[]; tasks: { id: number; videoId: number; jobId: string }[];
  }>;
  dispose(): Promise<void>;
}
const upload = (index = 0) => ({ userId: "owner", storageBytes: 1, fileKey: `videos/owner/${index}.mp4`, title: "Clip", description: "" });
const identity: CreationIdempotency = { action: "request_video_upload", key: "same-upload", requestHash: "a".repeat(64) };
const youtube = { userId: "owner", sourceUrl: "https://www.youtube.com/watch?v=abcdefghijk", youtubeVideoId: "abcdefghijk", title: "Youtube", description: "" };

export function videoUploadContract(backend: string, createFixture: () => Promise<VideoUploadFixture>) {
  describe(`${backend}: video registration contract`, () => {
    let fixture: VideoUploadFixture | undefined;
    beforeEach(async () => { fixture = await createFixture(); }, 20_000);
    afterEach(async () => { await fixture?.dispose(); fixture = undefined; });
    const current = () => {
      if (!fixture) throw new Error("Video fixture was not initialized");
      return fixture;
    };
    it("keeps concurrent uploads inside both quotas with no orphan receipts", async () => {
      const f = current();
      await f.seedOwner({ storageLimit: 100, monthlyLimit: 3 });
      const results = await Promise.all(Array.from({ length: 12 }, (_, i) => f.repository.reserveUpload(upload(i))));
      expect(results.filter(result => "ok" in result)).toHaveLength(3);
      expect(results.filter(result => "monthlyUploadExceeded" in result)).toHaveLength(9);
      const state = await f.snapshot();
      expect(state.videos).toHaveLength(3);
      expect(state).toMatchObject({ storageBytes: 3, uploadBytes: 3, receiptCount: 0 });
    });
    it("reports storage exhaustion without consuming monthly allowance", async () => {
      const f = current(); await f.seedOwner({ storageLimit: 0, monthlyLimit: 100 });
      expect(await f.repository.reserveUpload(upload())).toEqual({ exceeded: true, limit: 0 });
      expect(await f.snapshot()).toMatchObject({ storageBytes: 0, uploadBytes: 0, videos: [], tasks: [], receiptCount: 0 });
    });
    it("keeps idempotent retries to one debit and checks request hashes", async () => {
      const f = current(); await f.seedOwner({ storageLimit: 1, monthlyLimit: 1 });
      const results = await Promise.all(Array.from({ length: 10 }, (_, i) => f.repository.reserveUpload({ ...upload(i), idempotency: identity })));
      expect(results.filter(result => "ok" in result && !result.reused)).toHaveLength(1);
      const successes = results.filter(result => "ok" in result);
      expect(successes).toHaveLength(10);
      expect(new Set(successes.map(result => result.videoId)).size).toBe(1);
      expect(new Set(successes.map(result => result.fileKey)).size).toBe(1);
      await f.blockOwner();
      expect(await f.repository.reserveUpload({ ...upload(), idempotency: identity })).toMatchObject({ ok: true, reused: true });
      expect(await f.repository.reserveUpload({ ...upload(), idempotency: { ...identity, requestHash: "b".repeat(64) } })).toEqual({ idempotencyConflict: true });
      expect(await f.snapshot()).toMatchObject({ storageBytes: 1, uploadBytes: 1, receiptCount: 1 });
    });
    it("rolls back video, quota and receipt when a video insert fails", async () => {
      const f = current(); await f.seedOwner();
      await expect(f.repository.reserveUpload({ ...upload(), title: "reject", idempotency: identity })).rejects.toThrow();
      expect(await f.snapshot()).toMatchObject({ storageBytes: 0, uploadBytes: 0, videos: [], tasks: [], receiptCount: 0 });
    });
    it("resets stale monthly usage while admitting the new upload", async () => {
      const f = current(); await f.seedOwner({ staleMonth: true, monthlyLimit: 1 });
      expect(await f.repository.reserveUpload(upload())).toMatchObject({ ok: true });
      expect(await f.snapshot()).toMatchObject({ storageBytes: 1, uploadBytes: 1 });
    });
    it("confirms once and saves exactly one matching job despite duplicate requests", async () => {
      const f = current(); await f.seedOwner();
      const result = await f.repository.reserveUpload(upload());
      if (!("ok" in result)) throw new Error("Expected upload reservation");
      expect(await f.repository.confirmUpload({ videoId: result.videoId, userId: "other", fileKey: result.fileKey })).toBe(false);
      expect(await f.repository.confirmUpload({ videoId: result.videoId, userId: "owner", fileKey: "wrong" })).toBe(false);
      const confirmations = await Promise.all(Array.from({ length: 10 }, () => f.repository.confirmUpload({ videoId: result.videoId, userId: "owner", fileKey: result.fileKey })));
      expect(confirmations.filter(Boolean)).toHaveLength(1);
      const state = await f.snapshot();
      expect(state.videos).toEqual([{ id: result.videoId, status: "pending" }]);
      expect(state.tasks).toHaveLength(1);
      expect(state.tasks[0]).toMatchObject({ videoId: result.videoId });
      expect(await f.repository.getUploadState(result.videoId, "other")).toEqual({ found: false });
    });
    it("rolls back confirmation when the outbox cannot be inserted", async () => {
      const f = current(); await f.seedOwner();
      const result = await f.repository.reserveUpload(upload());
      if (!("ok" in result)) throw new Error("Expected upload");
      await f.failOutbox();
      await expect(f.repository.confirmUpload({ videoId: result.videoId, userId: "owner", fileKey: result.fileKey })).rejects.toThrow();
      expect((await f.snapshot()).videos).toEqual([{ id: result.videoId, status: "uploading" }]);
      expect((await f.snapshot()).tasks).toEqual([]);
    });
    it("makes concurrent YouTube registration and its outbox idempotent", async () => {
      const f = current(); await f.seedOwner();
      const idempotency: CreationIdempotency = { ...identity, action: "create_youtube_video" };
      const results = await Promise.all(Array.from({ length: 10 }, () => f.repository.createYoutube({ ...youtube, idempotency })));
      expect(results.filter(result => "reused" in result && !result.reused)).toHaveLength(1);
      const state = await f.snapshot();
      expect(state.videos).toHaveLength(1); expect(state.tasks).toHaveLength(1);
      expect(state.tasks[0].videoId).toBe(state.videos[0].id);
      expect(state).toMatchObject({ storageBytes: 0, uploadBytes: 0, receiptCount: 1 });
    });
    it("rolls back YouTube registration when its outbox fails", async () => {
      const f = current(); await f.seedOwner(); await f.failOutbox();
      await expect(f.repository.createYoutube({ ...youtube, idempotency: { ...identity, action: "create_youtube_video" } })).rejects.toThrow();
      expect(await f.snapshot()).toMatchObject({ videos: [], tasks: [], receiptCount: 0 });
    });
    it("rejects missing owners and invalid reservation sizes", async () => {
      const f = current();
      await expect(f.repository.reserveUpload(upload())).rejects.toThrow("Quota owner not found");
      await f.seedOwner();
      for (const storageBytes of [0, -1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
        await expect(f.repository.reserveUpload({ ...upload(), storageBytes })).rejects.toThrow("positive safe integer");
      }
    });
  });
}
