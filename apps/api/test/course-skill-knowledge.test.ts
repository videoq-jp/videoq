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
});
