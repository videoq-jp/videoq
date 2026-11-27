import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { enforceThrottles, type RateLimitBackend } from '../../src/lib/rate-limit';
import type { Bindings } from '../../src/types/bindings';
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
    it('compensates gated A after B succeeds through the real backend', async () => {
      let reached!: () => void, rejectA!: () => void;
      const ready = new Promise<void>(r => { reached = r; });
      const gate = new Promise<void>(r => { rejectA = r; });
      const backend: RateLimitBackend = {...f.backend, async consume(key,...args) {
        if (key.endsWith('_blocked')) { reached(); await gate; return {allowed:false,retryAfterSec:1}; }
        return f.backend.consume(key,...args);
      }};
      const env = {RATE_LIMIT_BACKEND:backend} as Bindings;
      const scope = {scope:'course_invitation_user',ident:'owner'} as const;
      const a = enforceThrottles(env,[{...scope,cost:2},{scope:'course_invitation_course',ident:'blocked'}]);
      await ready;
      await f.age(100);
      expect(await enforceThrottles(env,[scope])).toBeNull();
      const key = 'throttle_course_invitation_user_owner';
      const bTime = (await f.backend.snapshot(key))!.lastRequestMs;
      rejectA();
      expect(await a).toMatchObject({allowed:false});
      expect(await f.backend.snapshot(key)).toEqual({count:1,lastRequestMs:bTime});
    });
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
    it('waits until the requested weighted capacity is available, not just the oldest unit', async () => {
      await f.backend.consume('shared', 10, 60, 1, 'old');
      await f.age(10);
      await f.backend.consume('shared', 10, 60, 9, 'new');
      await f.age(10);
      expect(await f.backend.consume('shared', 10, 60, 5)).toEqual({allowed:false,retryAfterSec:50});
      await f.age(40);
      expect(await f.backend.consume('shared', 10, 60, 5)).toEqual({allowed:false,retryAfterSec:10});
      await f.age(10);
      expect(await f.backend.consume('shared', 10, 60, 5)).toEqual({allowed:true,retryAfterSec:0});
    });
    it('recalculates weighted availability after a refund and at each expiry boundary', async () => {
      await f.backend.consume('shared', 6, 60, 2, 'old');
      await f.age(10);
      await f.backend.consume('shared', 6, 60, 2, 'middle');
      await f.age(10);
      await f.backend.consume('shared', 6, 60, 2, 'new');
      expect(await f.backend.consume('shared', 6, 60, 3)).toEqual({allowed:false,retryAfterSec:50});
      await f.backend.release('shared',60,'middle');
      expect(await f.backend.consume('shared', 6, 60, 3)).toEqual({allowed:false,retryAfterSec:40});
      await f.age(40);
      expect(await f.backend.consume('shared', 6, 60, 3)).toEqual({allowed:true,retryAfterSec:0});
    });
    it('keeps unit-cost and impossible-cost rejection hints bounded', async () => {
      await f.backend.consume('shared', 2, 60, 1);
      await f.age(10);
      await f.backend.consume('shared', 2, 60, 1);
      expect(await f.backend.consume('shared',2,60)).toEqual({allowed:false,retryAfterSec:50});
      expect(await f.backend.consume('shared',2,60,3)).toEqual({allowed:false,retryAfterSec:60});
      await f.age(60);
      expect(await f.backend.consume('shared',2,60,3)).toEqual({allowed:false,retryAfterSec:60});
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
