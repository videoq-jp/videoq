import { vi } from 'vitest';
import { createMemoryRateLimitBackend } from '../src/lib/rate-limit';
import { rateLimitContract } from './contracts/rate-limit.contract';
rateLimitContract('Memory', async () => {
  let now = 100000;
  const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
  const backend = createMemoryRateLimitBackend();
  return { backend, age: async seconds => { now += seconds * 1000; },
    seedLegacy: async () => { await backend.consume('shared', 3, 3600); },
    dispose: async () => { clock.mockRestore(); } };
});
