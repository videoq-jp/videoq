import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { rateLimitContract } from '../contracts/rate-limit.contract';
import type { RateLimitEntry } from '../../src/lib/rate-limit-history';
rateLimitContract('workerd DO', async () => {
  const stub = env.RATE_LIMITER.getByName(crypto.randomUUID());
  return { backend: {
    consume: (_key, ...args) => stub.consume(...args),
    release: (_key, ...args) => stub.release(...args),
    snapshot: () => stub.snapshot(), record: (_key, seconds) => stub.record(seconds),
  }, age: seconds => runInDurableObject(stub, async (_instance, state) => {
    const old = (await state.storage.get<RateLimitEntry[]>('history'))!;
    await state.storage.put('history', old.map(e => typeof e === 'number' ? e - seconds : {...e, at:e.at-seconds}));
  }), seedLegacy: () => runInDurableObject(stub, async (_instance, state) => {
    await state.storage.put({ history:[Date.now()/1000], windowSec:3600 });
  }), dispose: async () => {} };
});
