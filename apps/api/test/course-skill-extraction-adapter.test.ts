import { describe, expect, it, vi } from 'vitest';
import type { Bindings } from '../src/types/bindings';
import type { SkillKnowledgeChunk } from '../src/domain/learning/skill-knowledge';
import { extractCourseSkillKnowledge } from '../src/integrations/course-skill-knowledge';

const { generate, repository } = vi.hoisted(() => ({ generate: vi.fn(), repository: { readPage: vi.fn(), cached: vi.fn(), save: vi.fn(), visualSource: vi.fn() } }));
vi.mock('../src/integrations/course-skill-model', () => ({ generateCourseSkillJson: generate }));
vi.mock('../src/lib/visual-inspection', () => ({ readSparseFrames: async () => ({ frames: [{ timestamp_seconds: 1, jpeg_base64: '/9j/AA==' }] }) }));
vi.mock('../src/lib/chat-model', () => ({ createChatModel: () => ({ model: 'fixture' }) }));
vi.mock('../src/persistence/course-skill-knowledge-sql', () => ({ createSqlCourseSkillKnowledgeRepository: () => repository }));

const env = { DB: {}, PERSISTENCE_BACKEND: 'd1' } as Bindings;
const input = { lease: { id: 'build', ownerId: 'owner', token: 'lease', generation: 1 }, source: { membershipId: 1, videoId: 1, title: 'Lecture', status: 'completed', analysisRevision: 'r1', visualRevision: '', ready: true }, language: 'ja' as const, policyVersion: '1', maxModelCalls: 1 };
const subtitles = '1\n00:00:01,000 --> 00:00:02,000\nテストを書く前に\n\n2\n00:00:02,000 --> 00:00:03,000\n依存する時刻を固定する';
const fact = { kind: 'procedure', claim: 'テスト前に時刻の依存を固定する', appliesWhen: [], exceptions: [], evidence: [{ cueId: 'cue-0' }, { cueId: 'cue-1' }], requiresVisualEvidence: false, versionContext: { language: '', framework: '', version: '' } };
function prepare() {
  vi.clearAllMocks();
  repository.readPage.mockResolvedValue({ text: subtitles, nextOffset: subtitles.length, done: true });
  repository.cached.mockResolvedValue(null);
  repository.visualSource.mockResolvedValue(null);
  repository.save.mockResolvedValue(true);
}

describe('source-derived subtitle quotations', () => {
  it('attaches each original segment when the model selects a multi-segment sentence', async () => {
    prepare();
    generate.mockImplementation(async (_env, _owner, options) => options.schema.parse({ verificationFacts: [], facts: [fact] }));
    await extractCourseSkillKnowledge(env, input);
    const saved = repository.save.mock.calls[0][2] as SkillKnowledgeChunk;
    expect(saved.promptVersion).toBe('course-knowledge-v10');
    expect(saved.facts[0].evidence).toEqual([{ cueId: 'cue-0', quote: 'テストを書く前に' }, { cueId: 'cue-1', quote: '依存する時刻を固定する' }]);
    expect(saved.cues).toHaveLength(2);
    expect(saved.facts[0].versionContext).toEqual({ language: null, framework: null, version: null });
  });
  it('keeps source-stated verification in its dedicated channel', async () => {
    prepare();
    const text = '1\n00:00:01,000 --> 00:00:02,000\n予想した理由でテストが失敗することを確認する';
    repository.readPage.mockResolvedValue({ text, nextOffset: text.length, done: true });
    const { kind: _kind, ...verification } = fact;
    generate.mockImplementation(async (_env, _owner, options) => options.schema.parse({ facts: [], verificationFacts: [{ ...verification, claim: 'テストが予想した理由で失敗することを確認する', evidence: [{ cueId: 'cue-0' }] }] }));
    await extractCourseSkillKnowledge(env, input);
    const saved = repository.save.mock.calls[0][2] as SkillKnowledgeChunk;
    expect(saved.facts[0]).toMatchObject({ kind: 'verification', evidence: [{ cueId: 'cue-0', quote: '予想した理由でテストが失敗することを確認する' }] });
  });
  it('preserves explicitly selected implementation version metadata', async () => {
    prepare();
    const text = '1\n00:00:01,000 --> 00:00:02,000\nTypeScript 5.7で時刻の依存を固定する';
    repository.readPage.mockResolvedValue({ text, nextOffset: text.length, done: true });
    generate.mockImplementation(async (_env, _owner, options) => options.schema.parse({ verificationFacts: [], facts: [{ ...fact, evidence: [{ cueId: 'cue-0' }], versionContext: { language: 'TypeScript', framework: '', version: '5.7' } }] }));
    await extractCourseSkillKnowledge(env, input);
    expect((repository.save.mock.calls[0][2] as SkillKnowledgeChunk).facts[0].versionContext).toEqual({ language: 'TypeScript', framework: null, version: '5.7' });
  });
  it('also derives subtitle quotes for facts reviewed against existing frames', async () => {
    prepare();
    repository.visualSource.mockResolvedValue({ id: 1, fileKey: 'lecture.mp4', visualRunId: 'visual-1' });
    generate.mockImplementation(async (_env, _owner, options) => options.schema.parse({ verificationFacts: [], facts: [{ ...fact, requiresVisualEvidence: true,
      ...(options.name === 'course_visual_knowledge' ? { visualEvidence: [{ frameId: options.input.frames[0].id, observation: 'A clock dependency is visible.' }] } : {}),
    }] }));
    await extractCourseSkillKnowledge(env, { ...input, maxModelCalls: 2 });
    expect(generate.mock.calls.find(call => call[2].name === 'course_visual_knowledge')![2].system).toContain('in Japanese');
    expect(generate.mock.calls.find(call => call[2].name === 'course_visual_knowledge')![2]).toMatchObject({ structuredOutput: true, input: { frames: [{ cueIds: ['cue-0', 'cue-1'] }] } });
    const saved = repository.save.mock.calls.at(-1)![2] as SkillKnowledgeChunk;
    expect(saved.facts[0].status).toBe('supported');
    expect(saved.facts[0].evidence[1]).toEqual({ cueId: 'cue-1', quote: '依存する時刻を固定する' });
    expect(saved.facts[0].visualEvidence).toEqual([{ frameId: ':1000', observation: 'A clock dependency is visible.' }]);
    expect(JSON.stringify(saved)).not.toContain('/9j/AA==');
  });
  it('bounds real-model windows independently from database page size', async () => {
    prepare();
    const text = `1\n00:00:01,000 --> 00:00:02,000\n${'A'.repeat(1800)}\n\n2\n00:00:02,000 --> 00:00:03,000\n${'B'.repeat(1800)}`;
    repository.readPage.mockResolvedValue({ text, nextOffset: text.length, done: true });
    generate.mockImplementation(async (_env, _owner, options) => options.schema.parse({ verificationFacts: [], facts: [{ ...fact, evidence: [{ cueId: options.input.cues[0].id }] }] }));
    await extractCourseSkillKnowledge(env, { ...input, maxModelCalls: 2 });
    expect(generate).toHaveBeenCalledTimes(2);
    for (const call of generate.mock.calls) expect(call[2].input.cues.reduce((n: number, c: { text: string }) => n + c.text.length, 0)).toBeLessThanOrEqual(3000);
    expect(repository.save).toHaveBeenCalledTimes(2);
  });
  it('advertises only the current window cue IDs, excluding timestamps and earlier windows', async () => {
    prepare();
    const text = `1\n00:35:15,900 --> 00:35:19,680\n${'A'.repeat(1800)}\n\n2\n00:35:21,839 --> 00:35:24,000\n${'B'.repeat(1800)}`;
    repository.readPage.mockResolvedValue({ text, nextOffset: text.length, done: true });
    const seen: string[] = [];
    generate.mockImplementation(async (_env, _owner, options) => {
      const id = options.input.cues[0].id;
      expect(options.structuredOutput).toBe(true);
      const response = (cueId: string) => ({ verificationFacts: [], facts: [{ ...fact, evidence: [{ cueId }] }] });
      expect(options.schema.safeParse(response('cue-2115900')).success).toBe(false);
      for (const previous of seen) expect(options.schema.safeParse(response(previous)).success).toBe(false);
      seen.push(id);
      return options.schema.parse(response(id));
    });
    await extractCourseSkillKnowledge(env, { ...input, maxModelCalls: 2 });
    expect(seen).toEqual(['cue-0', 'cue-1']);
    expect(repository.save.mock.calls.map(call => (call[2] as SkillKnowledgeChunk).facts[0].evidence[0].cueId)).toEqual(seen);
  });
  it('rejects an oversized fact batch instead of accepting truncated output', async () => {
    prepare();
    generate.mockImplementation(async (_env, _owner, options) => options.schema.parse({ verificationFacts: [], facts: Array.from({ length: 5 }, () => fact) }));
    await expect(extractCourseSkillKnowledge(env, input)).rejects.toThrow();
    expect(repository.save).not.toHaveBeenCalled();
  });
  it.each(['exceptions', 'requiresVisualEvidence', 'versionContext'] as const)('rejects missing %s rather than silently defaulting source metadata', async field => {
    prepare();
    const partial: Partial<typeof fact> = { ...fact };
    delete partial[field];
    generate.mockImplementation(async (_env, _owner, options) => options.schema.parse({ verificationFacts: [], facts: [partial] }));
    await expect(extractCourseSkillKnowledge(env, input)).rejects.toThrow();
    expect(repository.save).not.toHaveBeenCalled();
  });
  it('rejects invented cue IDs before saving knowledge', async () => {
    prepare();
    generate.mockImplementation(async (_env, _owner, options) => options.schema.parse({ verificationFacts: [], facts: [{ ...fact, evidence: [{ cueId: 'cue-999' }] }] }));
    await expect(extractCourseSkillKnowledge(env, input)).rejects.toThrow();
    expect(repository.save).not.toHaveBeenCalled();
  });
  it('does not accept model-authored quotations in the ID-only response', async () => {
    prepare();
    generate.mockImplementation(async (_env, _owner, options) => options.schema.parse({ verificationFacts: [], facts: [{ ...fact, evidence: [{ cueId: 'cue-0', quote: 'invented' }] }] }));
    await expect(extractCourseSkillKnowledge(env, input)).rejects.toThrow();
    expect(repository.save).not.toHaveBeenCalled();
  });
});
