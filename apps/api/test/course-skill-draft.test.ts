import { describe, expect, it } from 'vitest';
import type { SkillDraft } from '@videoq/domain/agent-skills';
import type { SkillKnowledgeChunk } from '../src/domain/learning/skill-knowledge';
import { generateCourseSkillDrafts, type SkillDraftDependencies } from '../src/features/course-skills/draft-service';
import { renderCourseSkill, supportedSkillFacts, validateSkillDraft } from '../src/domain/learning/course-skill-draft';

const chunk: SkillKnowledgeChunk = { version: 1, videoId: 1, analysisRevision: 'r1', chunkIndex: 0, model: 'fixture', promptVersion: '1',
  cues: [{ id: 'cue-0', startMs: 1000, endMs: 2000, text: '引用の説明' }],
  facts: (['principle', 'procedure', 'verification'] as const).map((kind, i) => ({ id: `fact-${i}`, kind, claim: '説明', appliesWhen: ['条件'], exceptions: [], evidence: [{ cueId: 'cue-0', quote: '引用' }], requiresVisualEvidence: false, status: 'supported', versionContext: { language: null, framework: null, version: null } })),
};
const draft: SkillDraft = { slug: 'review-retry', title: '再試行をレビューする', description: '再試行処理の実装を調べるときに利用する', useWhen: ['再試行の実装'], doNotUseWhen: [],
  criteria: [{ decision: '判断', factIds: ['fact-0'] }], steps: [{ action: '調査', expectedResult: '確認済み', factIds: ['fact-1'] }], exceptions: [], checks: [{ check: '検証', factIds: ['fact-2'] }], examples: [] };
const deps: SkillDraftDependencies = { id: () => 'server-id', plan: () => Promise.resolve({ proposals: [{ existingSkillId: null, slug: draft.slug, objective: '再試行をレビューする', factIds: chunk.facts.map(f => f.id) }], issues: [] }), synthesize: () => Promise.resolve(draft), audit: () => Promise.resolve({ supported: true, issues: [] }) };

describe('task-based course skills', () => {
  it('refuses to render a saved candidate with a known frame outside its cited cue', () => {
    const facts = supportedSkillFacts([chunk]);
    facts[0] = { ...facts[0], requiresVisualEvidence: true, frames: [{ id: 'known-frame', timestampMs: 60000 }], visualEvidence: [{ frameId: 'known-frame', observation: 'Visible detail' }] };
    expect(() => renderCourseSkill(7, draft, facts)).toThrow('SKILL_INVALID_VISUAL_EVIDENCE');
    facts[0].frames = [{ id: 'known-frame', timestampMs: 1500 }];
    expect(() => renderCourseSkill(7, draft, facts)).not.toThrow();
  });
  it('generates an actionable draft with deterministic source files', async () => {
    const result = await generateCourseSkillDrafts(deps, [chunk]);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].task.skillId).toBe('server-id');
    const rendered = renderCourseSkill(7, draft, result.candidates[0].facts);
    expect(rendered.name).toBe('videoq-c7-review-retry');
    expect(rendered.files[0].content).toContain('references/sources.md#k-fact-0');
    expect(rendered.files[1].content).toContain('1000〜2000');
    expect(renderCourseSkill(7, draft, result.candidates[0].facts)).toEqual(rendered);
  });
  it('retains existing task identity despite a proposed renamed slug', async () => {
    const task = { skillId: 'existing', slug: draft.slug, objective: '元の目的', factIds: [] };
    const result = await generateCourseSkillDrafts({ ...deps, plan: () => Promise.resolve({ proposals: [{ existingSkillId: 'existing', slug: 'renamed', objective: '新しい説明', factIds: chunk.facts.map(f => f.id) }], issues: [] }) }, [chunk], [task]);
    expect(result.candidates[0].task.skillId).toBe('existing');
    expect(result.candidates[0].task.slug).toBe(draft.slug);
  });
  it('does not create a task from definitions or information without verification', async () => {
    const limited = { ...chunk, facts: chunk.facts.slice(0, 2) };
    const result = await generateCourseSkillDrafts({ ...deps, plan: () => Promise.resolve({ proposals: [{ existingSkillId: null, slug: draft.slug, objective: '説明', factIds: limited.facts.map(f => f.id) }], issues: [] }) }, [limited]);
    expect(result.candidates[0].draft).toBeNull();
    expect(result.candidates[0].issues).toContain('SKILL_INSUFFICIENT_TASK_KNOWLEDGE');
  });
  it('rejects invented source IDs and unknown task identities', async () => {
    await expect(generateCourseSkillDrafts({ ...deps, plan: () => Promise.resolve({ proposals: [{ existingSkillId: null, slug: draft.slug, objective: '説明', factIds: ['invented'] }], issues: [] }) }, [chunk])).rejects.toThrow('INVALID_SKILL_PLAN');
    await expect(generateCourseSkillDrafts({ ...deps, plan: () => Promise.resolve({ proposals: [{ existingSkillId: 'foreign', slug: draft.slug, objective: '説明', factIds: ['fact-0'] }], issues: [] }) }, [chunk])).rejects.toThrow('INVALID_SKILL_IDENTITY');
    expect(() => validateSkillDraft({ ...draft, checks: [{ check: '架空の検証', factIds: ['invented'] }] }, supportedSkillFacts([chunk]))).toThrow('SKILL_UNSUPPORTED_BLOCK');
  });
  it('excludes held visual facts and flags semantic audit failures for review', async () => {
    const held = { ...chunk, facts: chunk.facts.map(f => ({ ...f, status: 'needs_visual_review' as const, requiresVisualEvidence: true })) };
    expect(supportedSkillFacts([held])).toHaveLength(0);
    const result = await generateCourseSkillDrafts({ ...deps, audit: () => Promise.resolve({ supported: false, issues: ['適用条件に不足'] }) }, [chunk]);
    expect(result.candidates[0].issues).toContain('SKILL_SEMANTIC_REVIEW_REQUIRED');
  });
  it('does not synthesize unaffected tasks but can explicitly rebuild them', async () => {
    const existing = [{ skillId: 'existing', slug: draft.slug, objective: draft.title, factIds: chunk.facts.map(f => f.id) }];
    const planner = { ...deps, plan: () => Promise.resolve({ proposals: [{ existingSkillId: 'existing', slug: draft.slug, objective: draft.title, factIds: chunk.facts.map(f => f.id) }], issues: [] }) };
    expect((await generateCourseSkillDrafts(planner, [chunk], existing)).candidates).toHaveLength(0);
    expect((await generateCourseSkillDrafts(planner, [chunk], existing, { force: true })).candidates).toHaveLength(1);
  });  it('rejects invented exclusions and exceptions while retaining explicitly sourced ones', () => {
    const facts = supportedSkillFacts([chunk]);
    expect(() => validateSkillDraft({ ...draft, doNotUseWhen: ['Prototype policy'] }, facts)).toThrow('SKILL_UNSUPPORTED_EXCLUSION');
    const exception = { condition: 'Explicit condition', behavior: 'Source behavior', factIds: ['fact-0'] };
    expect(() => validateSkillDraft({ ...draft, exceptions: [exception] }, facts)).toThrow('SKILL_UNSUPPORTED_EXCEPTION');
    const sourced = facts.map(f => f.id === 'fact-0' ? { ...f, exceptions: ['Explicit condition'] } : f);
    expect(() => validateSkillDraft({ ...draft, doNotUseWhen: ['Explicit condition'], exceptions: [exception] }, sourced)).not.toThrow();
    expect(() => validateSkillDraft({ ...draft, exceptions: [{ ...exception, factIds: ['fact-1'] }] }, sourced)).toThrow('SKILL_UNSUPPORTED_EXCEPTION');
  });
  it('labels generated applications separately from course API specifications', () => {
    const example = { ...draft, examples: [{ situation: 'Example', application: 'Use a hypothetical helper', factIds: ['fact-0'] }] };
    expect(renderCourseSkill(7, example, supportedSkillFacts([chunk])).files[0].content).toContain('教材のAPI仕様や実装そのものを示すものではありません');
    expect(renderCourseSkill(7, example, supportedSkillFacts([chunk]), 'en').files[0].content).toContain('not API specifications');
  });

});
