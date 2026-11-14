import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { JobRepository } from "../../../src/persistence/contracts/job-repository";

export interface JobFixture {
  repository: JobRepository;
  expireLease(jobId: string): Promise<void>;
  dispose(): Promise<void>;
}
const identity = { jobId: "job-1", jobType: "transcribe", payloadSha256: "a".repeat(64) };
export function jobRepositoryContract(backend: string, createFixture: () => Promise<JobFixture>) {
  describe(`${backend}: JobRepository contract`, () => {
    let fixture: JobFixture | undefined;
    beforeEach(async () => { fixture = await createFixture(); });
    afterEach(async () => { await fixture?.dispose(); fixture = undefined; });
    const current = () => {
      if (!fixture) throw new Error("Fixture was not initialized");
      return fixture;
    };
    it("gives exactly one concurrent delivery a lease", async () => {
      const { repository } = current();
      const claims = await Promise.all(Array.from({ length: 12 }, () => repository.claim(identity)));
      expect(claims.filter(result => result.status === "claimed")).toHaveLength(1);
      expect(claims.filter(result => result.status === "busy")).toHaveLength(11);
    });
    it("preserves identity and completed replay barriers", async () => {
      const { repository } = current();
      const result = await repository.claim(identity);
      if (result.status !== "claimed") throw new Error("Expected lease");
      expect(await repository.complete(identity.jobId, "wrong-token")).toBe(false);
      expect(await repository.heartbeat(identity.jobId, result.leaseToken)).toBe(true);
      expect(await repository.complete(identity.jobId, result.leaseToken)).toBe(true);
      expect(await repository.claim(identity)).toEqual({ status: "completed" });
      expect(await repository.fail(identity.jobId, result.leaseToken, "TRANSCRIBE_FAILED")).toBe(false);
      expect(await repository.claim({ ...identity, payloadSha256: "b".repeat(64) })).toEqual({ status: "conflict" });
      expect(await repository.claim({ ...identity, jobType: "delete" })).toEqual({ status: "conflict" });
    });
    it("reclaims expired leases and fences out the old delivery", async () => {
      const { repository, expireLease } = current();
      const first = await repository.claim(identity);
      if (first.status !== "claimed") throw new Error("Expected lease");
      await expireLease(identity.jobId);
      expect(await repository.heartbeat(identity.jobId, first.leaseToken)).toBe(false);
      const second = await repository.claim(identity);
      if (second.status !== "claimed") throw new Error("Expected replacement lease");
      expect(second.leaseToken).not.toBe(first.leaseToken);
      expect(await repository.complete(identity.jobId, first.leaseToken)).toBe(false);
      expect(await repository.fail(identity.jobId, first.leaseToken, "STALE_FAILURE")).toBe(false);
      expect(await repository.complete(identity.jobId, second.leaseToken)).toBe(true);
    });
    it("allows failed deliveries to retry", async () => {
      const { repository } = current();
      const first = await repository.claim(identity);
      if (first.status !== "claimed") throw new Error("Expected lease");
      expect(await repository.fail(identity.jobId, "wrong-token", "FAILED")).toBe(false);
      expect(await repository.fail(identity.jobId, first.leaseToken, "FAILED")).toBe(true);
      expect((await repository.claim(identity)).status).toBe("claimed");
    });
    it("rejects invalid job identities before persistence", async () => {
      await expect(current().repository.claim({ ...identity, payloadSha256: "invalid" })).rejects.toThrow("Invalid job identity");
    });
  });
}
