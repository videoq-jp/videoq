import { describe, expect, it } from 'vitest';
import { skillTranscriptChunks, verifySkillKnowledge, type SkillKnowledgeChunk, type SkillKnowledge } from '../src/domain/learning/skill-knowledge';
import { extractSkillKnowledge } from '../src/features/course-skills/knowledge-service';

const srt = '1\r\n00:00:01,000 --> 00:00:04,000\r\n再試行には冪等性が必要 😀\r\n\r\n2\r\n00:00:05,000 --> 00:00:06,000\r\n重複実行を検証する';
const fact = (id = 'cue-0', quote = '再試行には冪等性が必要 😀'): SkillKnowledge => ({ kind: 'principle', claim: '再試行に備えて冪等性を確保する', appliesWhen: ['要求が再配送される'], exceptions: [], evidence: [{ cueId: id, quote }], requiresVisualEvidence: false, versionContext: { language: null, framework: null, version: null } });
function pages(text: string, size: number) {
  const characters = [...text];
  return (offset: number) => Promise.resolve({ text: characters.slice(offset, offset + size).join(''), nextOffset: Math.min(offset + size, characters.length), done: offset + size >= characters.length });
}

describe('subtitle-backed knowledge', () => {
  it.each([1, 2, 7, 33, 12000])('preserves evidence across CRLF and Unicode pages of size %i', async size => {
    const chunks = [];
    for await (const chunk of skillTranscriptChunks(pages(srt, size))) chunks.push(chunk);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].cues).toEqual([
      { id: 'cue-0', startMs: 1000, endMs: 4000, text: '再試行には冪等性が必要 😀' },
      { id: 'cue-1', startMs: 5000, endMs: 6000, text: '重複実行を検証する' },
    ]);
    expect(() => verifySkillKnowledge([fact()], chunks[0].cues)).not.toThrow();
    expect(() => verifySkillKnowledge([fact('made-up')], chunks[0].cues)).toThrow('SKILL_INVALID_EVIDENCE');
    expect(() => verifySkillKnowledge([fact('cue-0', '架空の説明')], chunks[0].cues)).toThrow('SKILL_INVALID_EVIDENCE');
  });
  it('rejects malformed and unbounded cues', async () => {
    const consume = async (value: string) => { for await (const chunk of skillTranscriptChunks(pages(value, 128), 100)) void chunk; };
    await expect(consume('invalid subtitle')).rejects.toThrow('SKILL_INVALID_SUBTITLES');
    await expect(consume('1\n00:00:01,000 --> 00:00:02,000\n' + 'x'.repeat(500))).rejects.toThrow('SKILL_SUBTITLE_CUE_TOO_LARGE');
  });
  it('rejects known frames outside the cited cue windows, including gaps between citations', () => {
    const cues = [{ id: 'cue-0', startMs: 913000, endMs: 949000, text: '再試行には冪等性が必要 😀' }, { id: 'cue-1', startMs: 1097000, endMs: 1175000, text: '後の説明' }];
    const frames = [774000, 910999, 911000, 951000, 951001, 1010000, 1095000].map(timestampMs => ({ id: String(timestampMs), timestampMs }));
    const reviewed = (timestamp: number, both = false) => ({ ...fact(), evidence: both ? [...fact().evidence, { cueId: 'cue-1', quote: '後の説明' }] : fact().evidence, requiresVisualEvidence: true, visualEvidence: [{ frameId: String(timestamp), observation: 'Visible source detail' }] });
    for (const timestamp of [774000, 910999, 951001, 1010000]) expect(() => verifySkillKnowledge([reviewed(timestamp)], cues, frames)).toThrow('SKILL_INVALID_VISUAL_EVIDENCE');
    for (const timestamp of [911000, 951000]) expect(() => verifySkillKnowledge([reviewed(timestamp)], cues, frames)).not.toThrow();
    expect(() => verifySkillKnowledge([reviewed(1010000, true)], cues, frames)).toThrow('SKILL_INVALID_VISUAL_EVIDENCE');
    expect(() => verifySkillKnowledge([reviewed(1095000, true)], cues, frames)).not.toThrow();
  });
  it('reuses extracted chunks after interruption and holds visual-dependent claims', async () => {
    const cache = new Map<string, SkillKnowledgeChunk>();
    let calls = 0;
    const input = { lease: { id: 'build', ownerId: 'owner', token: 'lease', generation: 1 },
      source: { membershipId: 1, videoId: 1, title: 'Title', status: 'completed', analysisRevision: 'r1', visualRevision: '', ready: true },
      language: 'ja' as const, policyVersion: '1', maxModelCalls: 1 };
    const deps = { repository: {
      readPage: (_lease: unknown, _video: number, offset: number) => pages(srt, 15)(offset),
      cached: (_lease: unknown, key: string) => Promise.resolve(cache.get(key) ?? null),
      save: (_lease: unknown, key: string, chunk: SkillKnowledgeChunk) => { cache.set(key, chunk); return Promise.resolve(true); },
    }, hash: (value: string) => Promise.resolve(value), now: () => 1000, model: 'fixture', promptVersion: '1',
    beforeModel: () => Promise.resolve(), extract: () => { calls++; return Promise.resolve([{ ...fact(), requiresVisualEvidence: true }]); } };
    const first = await extractSkillKnowledge(deps, input);
    const second = await extractSkillKnowledge(deps, input);
    expect(first.status).toBe('completed'); expect(second.modelCalls).toBe(0); expect(calls).toBe(1);
    expect([...cache.values()][0].facts[0].status).toBe('needs_visual_review');
    expect([...cache.values()][0].facts[0].id).toContain(':0');
  });
  it('does not store unsupported claims or commit after source invalidation', async () => {
    let saved = false;
    const input = { lease: { id: 'build', ownerId: 'owner', token: 'lease', generation: 1 }, source: { membershipId: 1, videoId: 1, title: 'Title', status: 'completed', analysisRevision: 'r1', visualRevision: '', ready: true }, language: 'ja' as const, policyVersion: '1', maxModelCalls: 1 };
    const deps = { repository: { readPage: (_lease: unknown, _video: number, offset: number) => pages(srt, 12000)(offset), cached: () => Promise.resolve(null), save: () => { saved = true; return Promise.resolve(false); } }, hash: () => Promise.resolve('hash'), now: () => 1000, model: 'fixture', promptVersion: '1', beforeModel: () => Promise.resolve(), extract: () => Promise.resolve([fact('foreign-cue')]) };
    await expect(extractSkillKnowledge(deps, input)).rejects.toThrow('SKILL_INVALID_EVIDENCE');
    expect(saved).toBe(false);
    await expect(extractSkillKnowledge({ ...deps, extract: () => Promise.resolve([fact()]) }, input)).rejects.toThrow('SKILL_INPUT_CHANGED');
  });
  it('resumes visual reading from cached subtitles, validates frame IDs and saves no image bytes', async () => {
    const cache = new Map<string, SkillKnowledgeChunk>();
    let subtitleCalls = 0, visualCalls = 0;
    const input = { lease: { id: 'build', ownerId: 'owner', token: 'lease', generation: 1 }, source: { membershipId: 1, videoId: 1, title: 'Title', status: 'completed', analysisRevision: 'r1', visualRevision: 'visual-r1', ready: true }, language: 'ja' as const, policyVersion: '1', maxModelCalls: 1 };
    const frames = [{ id: 'frame-1', timestampMs: 2000, jpegBase64: 'PRIVATE_IMAGE_BYTES' }];
    const deps = { repository: {
      readPage: (_lease: unknown, _video: number, offset: number) => pages(srt, 12000)(offset),
      cached: (_lease: unknown, key: string) => Promise.resolve(cache.get(key) ?? null),
      save: (_lease: unknown, key: string, chunk: SkillKnowledgeChunk) => { cache.set(key, chunk); return Promise.resolve(true); },
    }, hash: async (value: string) => value, now: () => 1000, model: 'fixture', promptVersion: '2', beforeModel: async () => undefined,
      extract: async () => { subtitleCalls++; return [{ ...fact(), requiresVisualEvidence: true }]; },
      visuals: async () => frames,
      extractVisual: async () => { visualCalls++; return [{ ...fact(), requiresVisualEvidence: true, visualEvidence: [{ frameId: 'frame-1', observation: 'An idempotency key is shown.' }] }]; },
    };
    expect((await extractSkillKnowledge(deps, input)).status).toBe('budget_exhausted');
    const baseKey = [...cache.keys()][0], baseChunk = cache.get(baseKey)!;
    const legacyVisualKey = JSON.stringify({ key: baseKey, visualRevision: input.source.visualRevision, frames: frames.map(({ id, timestampMs }) => ({ id, timestampMs })) });
    cache.set(legacyVisualKey, { ...baseChunk, frames: [{ id: 'frame-1', timestampMs: 2000 }], facts: [{ ...baseChunk.facts[0], claim: 'Old interpretation without temporal validation' }] });
    const result = await extractSkillKnowledge(deps, input);
    expect(result.status).toBe('completed');
    expect(subtitleCalls).toBe(1); expect(visualCalls).toBe(1);
    const chunk = cache.get(result.keys[0])!;
    expect(chunk.facts[0].status).toBe('supported');
    expect(result.keys[0]).not.toBe(legacyVisualKey);
    expect(cache.has(legacyVisualKey)).toBe(true);
    expect(chunk.frames).toEqual([{ id: 'frame-1', timestampMs: 2000 }]);
    expect(JSON.stringify([...cache.values()])).not.toContain('PRIVATE_IMAGE_BYTES');
    await extractSkillKnowledge(deps, input);
    expect(visualCalls).toBe(1);
    expect(() => verifySkillKnowledge([{ ...fact(), visualEvidence: [{ frameId: 'invented', observation: 'invented' }] }], chunk.cues, chunk.frames)).toThrow('SKILL_INVALID_VISUAL_EVIDENCE');
    await extractSkillKnowledge(deps, { ...input, source: { ...input.source, visualRevision: 'visual-r2' } });
    expect(visualCalls).toBe(2); expect(subtitleCalls).toBe(1);
    await extractSkillKnowledge({ ...deps, visualPolicyVersion: 'cue-window-v1-postgres-run-v1' }, { ...input, source: { ...input.source, visualRevision: 'visual-r2' } });
    expect(visualCalls).toBe(3); expect(subtitleCalls).toBe(1);
  });

});
