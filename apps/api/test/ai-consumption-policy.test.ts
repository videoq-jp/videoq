import { expect, it } from 'vitest';
import { aiQuotaConsumed } from '../src/domain/billing/ai-consumption';
it('retains the explicit product-specific consumption milestones', () => {
  expect(aiQuotaConsumed({ kind: 'completed_answer' })).toBe(true);
  for (const committed of [false, true]) expect(aiQuotaConsumed({ kind: 'failed_answer', committed })).toBe(committed);
  for (const textGenerated of [false, true]) expect(aiQuotaConsumed({ kind: 'interrupted_stream', textGenerated })).toBe(textGenerated);
  for (const status of ['started', 'failed', 'interrupted']) expect(aiQuotaConsumed({ kind: 'provider_work', calls: [{ status }] })).toBe(false);
  expect(aiQuotaConsumed({ kind: 'provider_work', calls: [] })).toBe(false);
  expect(aiQuotaConsumed({ kind: 'provider_work', calls: [{ status: 'failed' }, { status: 'completed' }] })).toBe(true);
});
