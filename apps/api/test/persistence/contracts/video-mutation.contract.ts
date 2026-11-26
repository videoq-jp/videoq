import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { VideoMutationRepository } from "../../../src/persistence/contracts/video-mutation-repository";
import { videoDeletionAllowed } from '../../../src/domain/media/video-mutation';

export interface VideoMutationFixture {
  repository: VideoMutationRepository;
  seed(status?: "completed" | "uploading", staleUploadPeriod?: boolean): Promise<number>;
  rejectOutbox(): Promise<void>;
  setHeartbeat(videoId: number, heartbeat: string | null): Promise<void>;
  setReservationPeriod(videoId: number, offsetMs: number | null): Promise<void>;
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
    it.each([
      { status: 'uploading' as const, stale: false, remaining: 0 },
      { status: 'uploading' as const, stale: true, remaining: 5 },
      { status: 'completed' as const, stale: false, remaining: 5 },
    ])('refunds only an unconfirmed reservation in its original month: %j', async ({ status, stale, remaining }) => {
      const f=current(),id=await f.seed(status,stale);
      expect(await f.repository.delete(id,'owner')).toMatchObject({deleted:true,cleanupTaskId:expect.any(Number)});
      expect(await f.repository.delete(id,'owner')).toEqual({deleted:false,cleanupTaskId:null});
      expect(await f.snapshot()).toMatchObject({videos:0,uploadBytes:remaining,storageBytes:5});
    });
    it('refuses deletion precondition mismatches without changing quota or queuing cleanup', async () => {
      const f=current(),id=await f.seed('uploading');
      for(const options of [{expectedStatus:'completed'},{expectedFileKey:'replacement.mp4'}])
        expect(await f.repository.delete(id,'owner',options)).toEqual({deleted:false,cleanupTaskId:null});
      expect(await f.snapshot()).toMatchObject({videos:1,externalTasks:0,uploadBytes:5,storageBytes:5});
    });
    it("rejects invalid deletion accounting inputs", async () => {
      const f = current(); const id = await f.seed();
      for (const fallbackStorageBytes of [-1, 0.1, Number.MAX_SAFE_INTEGER + 1]) {
        await expect(f.repository.delete(id, "owner", { fallbackStorageBytes })).rejects.toThrow("Invalid video deletion options");
      }
    });
    it.each([null, '2026-11-01T00:00:00.999Z', '2026-11-01T00:00:01.000Z', '2026-11-01T00:00:01.001Z'])(
      'matches the pure abandonment policy at heartbeat boundary %s', async heartbeat => {
        const f = current(), id = await f.seed('uploading');
        await f.setHeartbeat(id, heartbeat);
        const options = { expectedStatus: 'uploading', inactiveBefore: new Date('2026-11-01T00:00:01.000Z') };
        const allowed = videoDeletionAllowed({ status: 'uploading', file: '', heartbeat }, options);
        expect((await f.repository.delete(id, 'owner', options)).deleted).toBe(allowed);
        expect(await f.snapshot()).toMatchObject({ videos: allowed ? 0 : 1, uploadBytes: allowed ? 0 : 5 });
      });
    it.each([null, -1, 0, 1])('refunds only the exact reservation period at month boundary offset %s', async offset => {
      const f = current(), id = await f.seed('uploading');
      await f.setReservationPeriod(id, offset);
      expect((await f.repository.delete(id, 'owner')).deleted).toBe(true);
      expect((await f.snapshot()).uploadBytes).toBe(offset === 0 ? 0 : 5);
      expect((await f.repository.delete(id, 'owner')).deleted).toBe(false);
      expect((await f.snapshot()).uploadBytes).toBe(offset === 0 ? 0 : 5);
    });
  });
}
