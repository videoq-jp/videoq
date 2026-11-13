import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { VideoMutationRepository } from "../../../src/persistence/contracts/video-mutation-repository";

export interface VideoMutationFixture {
  repository: VideoMutationRepository;
  seed(status?: "completed" | "uploading", staleUploadPeriod?: boolean): Promise<number>;
  rejectOutbox(): Promise<void>;
  snapshot(): Promise<{ videos: number; scenes: number; receipts: number; externalTasks: number; uploadBytes: number; storageBytes: number }>;
  dispose(): Promise<void>;
}
export function videoMutationContract(backend: string, createFixture: () => Promise<VideoMutationFixture>) {
  describe(`${backend}: video mutation contract`, () => {
    let fixture: VideoMutationFixture | undefined;
    beforeEach(async () => { fixture = await createFixture(); }, 20_000);
    afterEach(async () => { await fixture?.dispose(); fixture = undefined; });
    const current = () => { if (!fixture) throw new Error("Mutation fixture not initialized"); return fixture; };
    it("updates metadata without reindexing, then queues each distinct transcript once", async () => {
      const f = current(); const id = await f.seed();
      expect(await f.repository.update(id, "other", { title: "Unauthorized" })).toEqual({ notFound: true });
      expect(await f.repository.update(id, "owner", { title: "Renamed" })).toMatchObject({ row: { id, title: "Renamed", transcript: "Original" }, reindexTaskId: null });
      const results = await Promise.all(Array.from({ length: 8 }, () => f.repository.update(id, "owner", { transcript: "Updated" })));
      expect(results.filter(result => "reindexTaskId" in result && result.reindexTaskId !== null)).toHaveLength(1);
      expect((await f.snapshot()).externalTasks).toBe(1);
    });
    it("checks ownership and expected state before deleting and queues one cleanup", async () => {
      const f = current(); const id = await f.seed();
      expect(await f.repository.delete(id, "other")).toEqual({ deleted: false, cleanupTaskId: null });
      expect(await f.repository.delete(id, "owner", { expectedStatus: "uploading" })).toEqual({ deleted: false, cleanupTaskId: null });
      expect(await f.repository.delete(id, "owner", { expectedFileKey: "wrong" })).toEqual({ deleted: false, cleanupTaskId: null });
      const results = await Promise.all(Array.from({ length: 6 }, () => f.repository.delete(id, "owner")));
      expect(results.filter(result => result.deleted)).toHaveLength(1);
      expect(await f.snapshot()).toMatchObject({ videos: 0, scenes: 0, externalTasks: 1, receipts: 0, uploadBytes: 5, storageBytes: 5 });
    });
    it("refunds only a current-month unconfirmed upload and never refunds twice", async () => {
      const f = current(); const id = await f.seed("uploading");
      expect((await f.repository.delete(id, "owner")).deleted).toBe(true);
      expect((await f.repository.delete(id, "owner")).deleted).toBe(false);
      expect(await f.snapshot()).toMatchObject({ uploadBytes: 0, storageBytes: 5, externalTasks: 1 });
    });
    it("keeps a new month's usage when an old reservation is aborted", async () => {
      const f = current(); const id = await f.seed("uploading", true);
      expect((await f.repository.delete(id, "owner")).deleted).toBe(true);
      expect((await f.snapshot()).uploadBytes).toBe(5);
    });
    it("rolls back deletion and related rows when durable cleanup cannot be saved", async () => {
      const f = current(); const id = await f.seed("uploading"); await f.rejectOutbox();
      await expect(f.repository.delete(id, "owner")).rejects.toThrow();
      expect(await f.snapshot()).toMatchObject({ videos: 1, scenes: 1, externalTasks: 0, receipts: 0, uploadBytes: 5, storageBytes: 5 });
    });
    it("rejects invalid deletion accounting inputs", async () => {
      const f = current(); const id = await f.seed();
      for (const fallbackStorageBytes of [-1, 0.1, Number.MAX_SAFE_INTEGER + 1]) {
        await expect(f.repository.delete(id, "owner", { fallbackStorageBytes })).rejects.toThrow("Invalid video deletion options");
      }
    });
  });
}
