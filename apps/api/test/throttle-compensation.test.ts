import { afterEach, expect, it, vi } from 'vitest';
import { createMemoryRateLimitBackend, enforceThrottles, type RateLimitBackend } from '../src/lib/rate-limit';
import type { Bindings } from '../src/types/bindings';
afterEach(() => vi.restoreAllMocks());
it('refunds A without deleting successful B or shortening its window', async () => {
  const clock = vi.spyOn(Date, 'now').mockReturnValue(100000);
  const real = createMemoryRateLimitBackend();
  let ready!: () => void, deny!: () => void;
  const reached = new Promise<void>(r => { ready = r; });
  const gate = new Promise<void>(r => { deny = r; });
  const backend: RateLimitBackend = { ...real, async consume(key, ...args) {
    if (key.endsWith('_blocked')) { ready(); await gate; return { allowed: false, retryAfterSec: 1 }; }
    return real.consume(key, ...args);
  } };
  const env = { RATE_LIMIT_BACKEND: backend } as Bindings;
  const a = enforceThrottles(env, [{scope:'course_invitation_user',ident:'owner',cost:2}, {scope:'course_invitation_course',ident:'blocked'}]);
  await reached;
  clock.mockReturnValue(110000);
  expect(await enforceThrottles(env, [{scope:'course_invitation_user',ident:'owner'}, {scope:'course_invitation_course',ident:'open'}])).toBeNull();
  deny(); await a;
  expect(await real.snapshot('throttle_course_invitation_user_owner')).toEqual({count:1,lastRequestMs:110000});
  clock.mockReturnValue(3701000);
  expect(await real.snapshot('throttle_course_invitation_user_owner')).toMatchObject({count:1});
});
it('compensates only known successful scopes when a later consume throws', async () => {
  const real = createMemoryRateLimitBackend(), failure = new Error('backend unavailable');
  const env = { RATE_LIMIT_BACKEND: { ...real, async consume(key: string, ...args: Parameters<RateLimitBackend['consume']> extends [string, ...infer A] ? A : never) {
    if (key.endsWith('_broken')) { await real.consume(key, ...args); throw failure; }
    return real.consume(key, ...args);
  } } } as Bindings;
  await expect(enforceThrottles(env,[{scope:'login_ip',ident:'ip',cost:2},{scope:'login_username',ident:'broken'}])).rejects.toBe(failure);
  expect(await real.snapshot('throttle_login_ip_ip')).toBeNull();
  // The failed RPC may have committed: its uncertain consumption stays fail-closed.
  expect(await real.snapshot('throttle_login_username_broken')).toMatchObject({count:1});
});
it('keeps the original consume error and reports compensation failures', async () => {
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  const real = createMemoryRateLimitBackend(), failure = new Error('backend unavailable');
  const backend: RateLimitBackend = { ...real, async consume(key,...args) { if(key.endsWith('_broken')) throw failure; return real.consume(key,...args); }, async release() { throw new Error('release unavailable'); } };
  await expect(enforceThrottles({RATE_LIMIT_BACKEND:backend} as Bindings,[{scope:'login_ip',ident:'ip'},{scope:'login_username',ident:'broken'}])).rejects.toBe(failure);
  expect(log).toHaveBeenCalledWith(expect.stringContaining('throttle_compensation_failed'));
  expect(await real.snapshot('throttle_login_ip_ip')).toMatchObject({count:1});
});
