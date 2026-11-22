import { describe, expect, it, vi } from 'vitest';
import fixtures from './fixtures/python-scene-splitting.json';
import { createSceneEncoding } from '../src/integrations/search-index/tokenizer';
import { parseSearchScenes, splitSearchScenes } from '../src/application/search-scene-splitting';
import { executeLeasedAccountDeletion, executeTranscriptIndex } from '../src/application/search-index-execution';
const encoding = await createSceneEncoding('@cf/google/embeddinggemma-2', 'workers-ai');
describe('Python scene splitting parity', () => {
  it.each(fixtures)('$name', async fixture => {
    const split = splitSearchScenes(fixture.transcript, { encoding, embed: async () => fixture.vectors.map(vector => [...vector]) }, fixture.maxTokens);
    if (fixture.error) { await expect(split).rejects.toThrow('too small'); return; }
    const output = await split;
    expect(output).toBe(fixture.expected);
    for (const scene of parseSearchScenes(output)) expect(encoding.encode(scene.text).length).toBeLessThanOrEqual(fixture.maxTokens);
  });
  it('preserves source cue numbers when best-effort grouping falls back', () => {
    expect(parseSearchScenes('7\n00:00:00,000 --> 00:00:01,000\nfirst\n\n11\n00:00:01,000 --> 00:00:02,000\nsecond').map(s => s.index)).toEqual([7, 11]);
  });
  it('rejects token slices cutting UTF-8 and preserves literal special tokens', () => {
    const tokens = encoding.encode('😀');
    expect(encoding.decodeStrict(tokens)).toBe('😀');
    expect(() => encoding.decodeStrict(tokens.slice(0, 1))).toThrow();
    const text = '<|endoftext|> caption';
    expect(encoding.decodeStrict(encoding.encode(text))).toBe(text);
  });
  it('does not call the model for bounded scenes', async () => {
    const embed = vi.fn();
    await splitSearchScenes(fixtures[0].transcript, { encoding, embed });
    expect(embed).not.toHaveBeenCalled();
  });
  it('rejects embedding row count drift', async () => {
    const f = fixtures.find(f => f.name === 'otsu')!;
    await expect(splitSearchScenes(f.transcript, { encoding, embed: async () => [[1]] }, f.maxTokens)).rejects.toThrow('Invalid scene embeddings');
  });
});
describe('atomic indexing orchestration', () => {
  it('finishes provider calls before the replacement transaction', async () => {
    const calls: string[] = [];
    const count = await executeTranscriptIndex(1, fixtures[0].transcript, {
      prepareReplacement: async () => { calls.push('prepare'); return async (scenes, vectors) => { calls.push('replace'); expect(vectors).toHaveLength(scenes.length); return scenes.length; }; },
      split: async s => { calls.push('split'); return s; },
      embed: async texts => { calls.push('embed'); return texts.map(() => [1]); },
    });
    expect(count).toBe(4);
    expect(calls).toEqual(['prepare', 'split', 'embed', 'replace']);
  });
  it('does not replace an index after provider failure or output drift', async () => {
    const replace = vi.fn();
    for (const embed of [async (): Promise<number[][]> => { throw new Error('provider unavailable'); }, async () => []]) {
      await expect(executeTranscriptIndex(1, fixtures[0].transcript, { prepareReplacement: async () => replace, split: async s => s, embed })).rejects.toThrow();
    }
    expect(replace).not.toHaveBeenCalled();
  });
  it('rejects malformed captions before storage work', async () => {
    const prepareReplacement = vi.fn();
    await expect(executeTranscriptIndex(1, 'bad', { prepareReplacement, split: vi.fn(), embed: vi.fn() })).rejects.toThrow('no valid SRT');
    expect(prepareReplacement).not.toHaveBeenCalled();
  });
});
describe('leased account deletion', () => {
  it('renews before each step', async () => {
    const renew = vi.fn(async () => true), step = vi.fn().mockResolvedValueOnce({ status: 'progress' }).mockResolvedValueOnce({ status: 'completed' });
    await executeLeasedAccountDeletion({ renew, step });
    expect(renew).toHaveBeenCalledTimes(2);
    expect(step).toHaveBeenCalledTimes(2);
  });
  it('stops before mutation after lease loss', async () => {
    const step = vi.fn();
    await expect(executeLeasedAccountDeletion({ renew: async () => false, step })).rejects.toThrow('lease was lost');
    expect(step).not.toHaveBeenCalled();
  });
  it('rejects revoked authorization', async () => {
    await expect(executeLeasedAccountDeletion({ renew: async () => true, step: async () => ({ status: 'denied' }) })).rejects.toThrow('authorization was lost');
  });
  it('bounds work and requests retry', async () => {
    const step = vi.fn(async () => ({ status: 'progress' as const }));
    await expect(executeLeasedAccountDeletion({ renew: async () => true, step }, 2)).rejects.toThrow('step budget exhausted');
    expect(step).toHaveBeenCalledTimes(2);
  });
});
