import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ProcessingQuotaRepository } from "../../../src/persistence/contracts/processing-quota";
export type QuotaFixture = {
  repository: ProcessingQuotaRepository;
  execute(sql: string, args?: unknown[]): Promise<void>;
  used(): Promise<{ seconds: number; answers: number }>;
  failVideoUpdate(): Promise<void>;
  dispose(): Promise<void>;
};
export function processingQuotaContract(name: string, create: () => Promise<QuotaFixture>) {
  describe(`${name}: processing quota`, () => {
    let f: QuotaFixture;
    beforeEach(async () => { f = await create(); });
    afterEach(async () => { await f?.dispose(); });
    it("admits only available capacity across concurrent different videos", async () => {
      const results = await Promise.all(Array.from({ length: 8 }, (_, i) => f.repository.reserve(i + 1, 30)));
      expect(results.filter(r => r.allowed)).toHaveLength(2);
      expect(await f.used()).toEqual({ seconds: 60, answers: 7 });
    });
    it("reserves once across duplicate deliveries, including after month rollover", async () => {
      const results = await Promise.all(Array.from({ length: 10 }, () => f.repository.reserve(1, 30)));
      expect(results.every(r => r.allowed)).toBe(true);
      expect((await f.used()).seconds).toBe(30);
      await f.execute("UPDATE users SET usage_period_start='2000-01-01T00:00:00.000Z'");
      expect((await f.repository.reserve(1, 60)).allowed).toBe(true);
      expect((await f.used()).seconds).toBe(30);
    });
    it("resets shared processing and AI usage together for a new month", async () => {
      await f.execute("UPDATE users SET usage_period_start='2000-01-01T00:00:00.000Z',used_processing_seconds=999");
      expect(await f.repository.reserve(1, 60)).toEqual({ allowed: true, limitSeconds: 60 });
      expect(await f.used()).toEqual({ seconds: 60, answers: 0 });
    });
    it("denies blocked users and supports unlimited plans", async () => {
      await f.execute("UPDATE users SET is_over_quota=true,processing_limit_minutes=NULL");
      expect(await f.repository.reserve(1, 500)).toEqual({ allowed: false, limitSeconds: null });
      await f.execute("UPDATE users SET is_over_quota=false");
      expect(await f.repository.reserve(1, 500)).toEqual({ allowed: true, limitSeconds: null });
    });
    it("rolls back user debit when the video write fails", async () => {
      await f.failVideoUpdate();
      await expect(f.repository.reserve(1, 13)).rejects.toThrow();
      expect(await f.used()).toEqual({ seconds: 0, answers: 7 });
    });
    it("rejects missing videos, unsafe numbers and usage overflow", async () => {
      await expect(f.repository.reserve(999, 1)).rejects.toThrow("not found");
      await expect(f.repository.reserve(1, 0)).rejects.toThrow("safe integers");
      await expect(f.repository.reserve(1, Number.MAX_SAFE_INTEGER + 1)).rejects.toThrow("safe integers");
      await expect(f.repository.reserve(1, 2_147_483_648)).rejects.toThrow("safe integers");
      await f.execute("UPDATE users SET processing_limit_minutes=NULL,used_processing_seconds=?", [Number.MAX_SAFE_INTEGER]);
      expect((await f.repository.reserve(1, 1)).allowed).toBe(false);
    });
  });
}
