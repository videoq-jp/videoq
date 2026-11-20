import { expect, it, vi } from 'vitest';
import { SceneCollector, extractLatestUserQuery } from '../src/features/chat/evidence-registry';
import { AnswerCostLedgerState } from '../src/features/billing/cost-ledger';
import { createAccountCredentialService } from '../src/features/account/service';

it('keeps restored citation IDs reserved while filtering current allowed sources', () => {
  const registry = new SceneCollector([20]);
  registry.restore([{ id: 1, video_id: 10, title: 'old', start_time: '00:00:00', end_time: '00:00:10' }]);
  const hit = { videoId: 20, videoTitle: 'current', startTime: '00:00:00', endTime: '00:00:10', content: 'first' };
  expect(registry.add(hit)).toBe(2);
  expect(registry.add({ ...hit, content: 'second' })).toBe(2);
  expect(registry.add({ ...hit, content: 'second' })).toBe(2);
  expect(registry.add({ ...hit, evidenceType: 'visual' })).toBe(3);
  expect(registry.savedSources.map(source => source.id)).toEqual([1, 2, 3]);
  expect(registry.sources.map(source => source.id)).toEqual([2, 3]);
  expect(registry.hits[0].content).toBe('first\nsecond');
});

it('selects the latest real user question while preserving the legacy fallback', () => {
  expect(extractLatestUserQuery([{ role: 'user', content: 'question' }, { role: 'assistant', content: 'answer' }])).toBe('question');
  expect(extractLatestUserQuery([{ role: 'assistant', content: 'fallback' }])).toBe('fallback');
  expect(extractLatestUserQuery([])).toBe('');
});

it('finishes a usage call once and interrupts only unfinished calls through the injected clock', () => {
  let tick = 0;
  const ledger = new AnswerCostLedgerState({ newId: () => 'attempt', now: () => String(++tick) });
  const call = ledger.begin('answer_model', 'model');
  call.complete({ tokens: 10, prompt: 'private', invalid: Infinity, negative: -1, array: [1], nested: { cached: 2 } });
  call.fail({ tokens: 100 });
  ledger.begin('query_embedding', 'embedding');
  ledger.interruptPending();
  expect(ledger.id).toBe('attempt');
  expect(ledger.calls[0]).toMatchObject({ status: 'completed', startedAt: '1', finishedAt: '2', usage: { tokens: 10, nested: { cached: 2 } } });
  expect(ledger.calls[1]).toMatchObject({ status: 'interrupted', startedAt: '3', finishedAt: '4' });
  expect(JSON.stringify(ledger.calls)).not.toContain('private');
});

it('never passes a plaintext account credential to persistence', async () => {
  const write = vi.fn().mockResolvedValue(true);
  const encrypt = vi.fn().mockResolvedValue('ciphertext');
  const actorId = vi.fn().mockReturnValue('owner');
  const credentials = createAccountCredentialService({ actorId, encrypt,
    repository: { getSearchApiKeyStatus: vi.fn(), setSearchApiKey: write } });
  expect(await credentials.save('private-key')).toBe(true);
  expect(encrypt).toHaveBeenCalledWith('private-key');
  expect(write).toHaveBeenCalledExactlyOnceWith('owner', 'ciphertext');
  expect(actorId).toHaveBeenCalledTimes(1);
});

it('does not resolve an actor or write when encryption fails', async () => {
  const write = vi.fn(), actorId = vi.fn();
  const failure = new Error('encryption unavailable');
  const credentials = createAccountCredentialService({ actorId, encrypt: vi.fn().mockRejectedValue(failure),
    repository: { getSearchApiKeyStatus: vi.fn(), setSearchApiKey: write } });
  await expect(credentials.save('private-key')).rejects.toBe(failure);
  expect(actorId).not.toHaveBeenCalled();
  expect(write).not.toHaveBeenCalled();
});

it('deletes a credential using null without invoking encryption', async () => {
  const encrypt = vi.fn(), write = vi.fn().mockResolvedValue(true);
  const credentials = createAccountCredentialService({ actorId: () => 'owner', encrypt,
    repository: { getSearchApiKeyStatus: vi.fn(), setSearchApiKey: write } });
  expect(await credentials.remove()).toBe(true);
  expect(write).toHaveBeenCalledExactlyOnceWith('owner', null);
  expect(encrypt).not.toHaveBeenCalled();
});
