import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ExternalTaskLeaseLostError, type ExternalTaskRepository } from "../../../src/persistence/contracts/external-task-repository";
import { buildJobMessage, JOB_TRANSCRIBE_VIDEO } from "../../../src/lib/job-message";

export interface ExternalTaskFixture {
  repository: ExternalTaskRepository;
  expireAndReady(id: number): Promise<void>;
  setAttempts(id: number, attempts: number): Promise<void>;
  createCleanup(effectApplied?: boolean): Promise<number>;
  rejectCompletion(): Promise<void>;
  seedHistory(): Promise<void>;
  snapshot(): Promise<{ storageBytes: number; overQuota: boolean; receipts: number; protectedJob: boolean; completed: number }>;
  dispose(): Promise<void>;
}
export function externalTaskContract(backend: string, createFixture: () => Promise<ExternalTaskFixture>) {
  describe(`${backend}: external task contract`, () => {
    let fixture: ExternalTaskFixture | undefined;
    beforeEach(async () => { fixture = await createFixture(); }, 20_000);
    afterEach(async () => { await fixture?.dispose(); fixture = undefined; });
    const current = () => { if (!fixture) throw new Error("Outbox fixture not initialized"); return fixture; };
    const job = () => current().repository.createJob({ message: buildJobMessage(JOB_TRANSCRIBE_VIDEO, { video_id: 1 }, "job-test"), dedupeKey: "job:test" });
    it("deduplicates persisted jobs and claims once under concurrent delivery", async () => {
      const f = current();
      const first = await job(); const replay = await job();
      expect(first.created).toBe(true); expect(replay).toEqual({ id: first.id, created: false });
      const claims = await Promise.all(Array.from({ length: 12 }, () => f.repository.claim({ limit: 1 })));
      const claimed = claims.flat(); expect(claimed).toHaveLength(1);
      expect(claimed[0].payload).toMatchObject({ message: { type: JOB_TRANSCRIBE_VIDEO, payload: { video_id: 1 } } });
      await f.repository.complete(claimed[0]);
      expect(await f.repository.claim({ limit: 1 })).toEqual([]);
    });
    it("honors explicit task IDs and exclusion lists", async () => {
      const f = current(); const first = await job();
      expect(await f.repository.claim({ limit: 1, taskId: first.id, excludeTaskIds: [first.id] })).toEqual([]);
      expect(await f.repository.claim({ limit: 1, taskId: first.id + 1 })).toEqual([]);
      expect((await f.repository.claim({ limit: 1, taskId: first.id }))[0].id).toBe(first.id);
    });
    it("fences out expired attempts after reclaiming", async () => {
      const f = current(); await job(); const [old] = await f.repository.claim({ limit: 1 });
      await f.expireAndReady(old.id);
      const [replacement] = await f.repository.claim({ limit: 1 });
      expect(replacement.attempt).toBe(old.attempt + 1);
      await expect(f.repository.complete(old)).rejects.toBeInstanceOf(ExternalTaskLeaseLostError);
      expect(await f.repository.fail(old, "old failure")).toEqual({ dead: false, leaseLost: true });
      await f.repository.complete(replacement);
    });
    it("defers without completing and fences old attempts after expiration and reclaim",async()=>{
      const f=current();await job();const [lease]=await f.repository.claim({limit:1});await f.repository.defer(lease,7200000);
      expect(await f.repository.claim({limit:1,taskId:lease.id})).toEqual([]);await expect(f.repository.complete(lease)).rejects.toBeInstanceOf(ExternalTaskLeaseLostError);
      await f.expireAndReady(lease.id);await expect(f.repository.defer(lease,1000)).rejects.toBeInstanceOf(ExternalTaskLeaseLostError);
      const [fresh]=await f.repository.claim({limit:1,taskId:lease.id});await expect(f.repository.defer(lease,1000)).rejects.toBeInstanceOf(ExternalTaskLeaseLostError);await f.repository.complete(fresh);await expect(f.repository.defer(fresh,1000)).rejects.toBeInstanceOf(ExternalTaskLeaseLostError);
    });
    it("validates deferred deadlines without changing the live lease",async()=>{
      const f=current();await job();const [lease]=await f.repository.claim({limit:1});for(const delay of [0,-1,1.5,NaN,Infinity,86400001])await expect(f.repository.defer(lease,delay)).rejects.toThrow();await f.repository.complete(lease);
    });
    it("returns storage exactly once and completes atomically", async () => {
      const f = current(); const id = await f.createCleanup();
      const [lease] = await f.repository.claim({ limit: 1, taskId: id });
      await f.repository.completeStorageCleanup({ lease, userId: "owner", bytes: 5 });
      expect(await f.snapshot()).toMatchObject({ storageBytes: 5, overQuota: false, completed: 1, receipts: 0 });
      await expect(f.repository.completeStorageCleanup({ lease, userId: "owner", bytes: 5 })).rejects.toBeInstanceOf(ExternalTaskLeaseLostError);
      expect((await f.snapshot()).storageBytes).toBe(5);
    });
    it("does not refund storage again when the effect is already recorded", async () => {
      const f = current(); const id = await f.createCleanup(true);
      const [lease] = await f.repository.claim({ limit: 1, taskId: id });
      await f.repository.completeStorageCleanup({ lease, userId: "owner", bytes: 5 });
      expect(await f.snapshot()).toMatchObject({ storageBytes: 10, overQuota: true, completed: 1, receipts: 0 });
    });
    it("rolls back the storage refund when completion SQL fails", async () => {
      const f = current(); const id = await f.createCleanup();
      const [lease] = await f.repository.claim({ limit: 1, taskId: id });
      await f.rejectCompletion();
      await expect(f.repository.completeStorageCleanup({ lease, userId: "owner", bytes: 5 })).rejects.toThrow();
      expect(await f.snapshot()).toMatchObject({ storageBytes: 10, overQuota: true, completed: 0, receipts: 0 });
    });
    it("backs off failures and stops claiming dead tasks", async () => {
      const f = current(); await job(); const [first] = await f.repository.claim({ limit: 1 });
      expect(await f.repository.fail(first, "temporary failure")).toEqual({ dead: false, leaseLost: false });
      expect(await f.repository.claim({ limit: 1 })).toEqual([]);
      await f.expireAndReady(first.id); await f.setAttempts(first.id, 47);
      const [last] = await f.repository.claim({ limit: 1 });
      expect(last.attempt).toBe(48);
      expect(await f.repository.fail(last, "terminal failure")).toEqual({ dead: true, leaseLost: false });
      expect(await f.repository.claim({ limit: 1 })).toEqual([]);
      expect(await f.repository.health()).toMatchObject({ pending: 0, dead: 1, oldestPendingSeconds: null });
    });
    it("prunes old completed history while preserving jobs referenced by pending delivery", async () => {
      const f = current(); await f.seedHistory();
      expect(await f.repository.pruneHistory()).toEqual({ externalTasks: 1, jobExecutions: 1 });
      expect((await f.snapshot()).protectedJob).toBe(true);
      expect(await f.repository.health()).toMatchObject({ pending: 1, dead: 0 });
    });
  });
}
