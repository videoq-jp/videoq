import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RateLimitBackend } from '../../src/lib/rate-limit';
/** Exercises the same refund semantics in Memory, real PG and workerd DO. */
export function rateLimitContract(name: string, setup: () => Promise<{
  backend: RateLimitBackend;
  age(seconds: number): Promise<void>;
  seedLegacy(): Promise<void>;
  dispose(): Promise<void>;
}>) {
  describe(`${name} reservation contract`, () => {
    let f: Awaited<ReturnType<typeof setup>>;
    beforeEach(async () => { f = await setup(); });
    afterEach(async () => { await f?.dispose(); });
    it('refunds weighted A, preserves B, and makes retries/unknown refunds harmless', async () => {
      await f.backend.consume('shared', 10, 3600, 2, 'A');
      await f.age(100);
      await f.backend.consume('shared', 10, 3600, 1, 'B');
      const last = (await f.backend.snapshot('shared'))!.lastRequestMs;
      await f.backend.release('shared', 3600, 'A');
      expect(await f.backend.snapshot('shared')).toEqual({count:1,lastRequestMs:last});
      await f.backend.release('shared', 3600, 'A');
      await f.backend.release('shared', 3600, 'unknown');
      expect(await f.backend.snapshot('shared')).toEqual({count:1,lastRequestMs:last});
    });
    it('distinguishes same-timestamp reservations and preserves denied/no-ID charges', async () => {
      await f.backend.consume('shared', 4, 3600, 2, 'A');
      await f.backend.consume('shared', 4, 3600, 1, 'B');
      await f.backend.consume('shared', 4, 3600); // non-refundable fallback charge
      expect((await f.backend.consume('shared', 4, 3600, 2, 'C')).allowed).toBe(false);
      await f.backend.release('shared', 3600, 'C');
      await f.backend.release('shared', 3600, 'B');
      expect(await f.backend.snapshot('shared')).toMatchObject({count:3});
      await f.backend.release('shared', 3600, 'A');
      expect(await f.backend.snapshot('shared')).toMatchObject({count:1});
    });
    it('does not remove a newer charge when the refundable one has already expired', async () => {
      await f.backend.consume('shared', 2, 3600, 1, 'expired');
      await f.age(3600);
      await f.backend.consume('shared', 2, 3600, 1, 'current');
      await f.backend.release('shared', 3600, 'expired');
      expect(await f.backend.snapshot('shared')).toMatchObject({count:1});
    });
    it('keeps pre-upgrade numeric history charged and expires it normally', async () => {
      await f.seedLegacy();
      await f.backend.consume('shared', 3, 3600, 1, 'new');
      await f.backend.release('shared', 3600, 'new');
      expect(await f.backend.snapshot('shared')).toMatchObject({count:1});
      await f.age(3600);
      expect(await f.backend.snapshot('shared')).toBeNull();
    });
  });
}
