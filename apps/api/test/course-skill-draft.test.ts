import { describe, expect, it, vi } from 'vitest';
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
  it('repairs an invalid initial exception before auditing and retains fixed sources', async () => {
    const invalid = { ...draft, exceptions: [{ condition: 'Invented', behavior: 'Do it', factIds: ['fact-0'] }] };
    const revise = vi.fn().mockResolvedValue(draft), audit = vi.fn().mockResolvedValue({ supported: true, issues: [] });
    const result = await generateCourseSkillDrafts({ ...deps, synthesize: async () => invalid, revise, audit }, [chunk]);
    expect(revise).toHaveBeenCalledWith(expect.objectContaining({ slug: draft.slug }), expect.any(Array), invalid, ['SKILL_UNSUPPORTED_EXCEPTION'], 1);
    expect(audit).toHaveBeenCalledTimes(1);
    expect(result.candidates[0]).toMatchObject({ draft, issues: [], generationRepair: { attempts: [{ status: 'passed' }] } });
  });
  it('holds an irreparable initial draft and continues to the next task', async () => {
    let id = 0;
    const invalid = { ...draft, exceptions: [{ condition: 'Invented', behavior: 'Do it', factIds: ['fact-0'] }] };
    const plan = async () => ({ proposals: ['review-retry', 'second-task'].map(slug => ({ existingSkillId: null, slug, objective: 'Review', factIds: chunk.facts.map(f => f.id) })), issues: [] });
    const revise = vi.fn().mockResolvedValue(invalid);
    const result = await generateCourseSkillDrafts({ ...deps, id: () => `task-${id++}`, plan, synthesize: async task => task.slug === draft.slug ? invalid : { ...draft, slug: task.slug }, revise }, [chunk]);
    expect(revise).toHaveBeenCalledTimes(2);
    expect(result.candidates[0]).toMatchObject({ draft: null, issues: expect.arrayContaining(['SKILL_AUTO_REPAIR_EXHAUSTED']) });
    expect(result.candidates[1]).toMatchObject({ draft: { slug: 'second-task' }, issues: [] });
  });

  it('holds a draft rejected during reference translation without admitting invented references', async () => {
    const result = await generateCourseSkillDrafts({ ...deps, synthesize: async () => { throw new Error('SKILL_UNSUPPORTED_FACT'); } }, [chunk]);
    expect(result.candidates[0]).toMatchObject({ draft: null, issues: ['SKILL_UNSUPPORTED_FACT', 'SKILL_INITIAL_DRAFT_INVALID'] });
  });
  it('never admits a changed task identity when initial repair cannot restore it', async () => {
    const wrong = { ...draft, slug: 'wrong-task' };
    const result = await generateCourseSkillDrafts({ ...deps, synthesize: async () => wrong, revise: async () => wrong }, [chunk]);
    expect(result.candidates[0]).toMatchObject({ draft: null, issues: expect.arrayContaining(['INVALID_SKILL_IDENTITY', 'SKILL_AUTO_REPAIR_EXHAUSTED']) });
  });
  it('repairs a failed audit against fixed source facts and audits the revised draft', async () => {
    const audit = vi.fn().mockResolvedValueOnce({ supported: false, issues: ['Preserve the source condition'] }).mockResolvedValue({ supported: true, issues: [] });
    const corrected = { ...draft, title: '修正済みの草案' };
    const revise = vi.fn().mockResolvedValue(corrected);
    const source = JSON.stringify(chunk);
    const result = await generateCourseSkillDrafts({ ...deps, audit, revise }, [chunk]);
    expect(revise).toHaveBeenCalledTimes(1);
    expect(revise).toHaveBeenCalledWith(expect.objectContaining({ slug: draft.slug }), expect.any(Array), draft, ['Preserve the source condition'], 1);
    expect(audit).toHaveBeenCalledTimes(2);
    expect(result.candidates[0]).toMatchObject({ draft: corrected, issues: [], generationRepair: { attempts: [{ number: 1, status: 'passed' }] } });
    expect(JSON.stringify(chunk)).toBe(source);
  });
  it('limits semantic revisions to two and holds the final draft when audits still fail', async () => {
    const audit = vi.fn().mockResolvedValue({ supported: false, issues: ['Not supported'] });
    const revise = vi.fn().mockResolvedValue({ ...draft, title: '検査に通らない修正版' });
    const result = await generateCourseSkillDrafts({ ...deps, audit, revise }, [chunk]);
    expect(revise.mock.calls.map(call => call[4])).toEqual([1, 2]);
    expect(audit).toHaveBeenCalledTimes(3);
    expect(result.candidates[0].issues).toEqual(expect.arrayContaining(['Not supported', 'SKILL_SEMANTIC_REVIEW_REQUIRED', 'SKILL_AUTO_REPAIR_EXHAUSTED']));
    expect(result.candidates[0].generationRepair?.attempts).toHaveLength(2);
  });
  it('retains the last valid draft when revisions invent source references', async () => {
    const audit = vi.fn().mockResolvedValue({ supported: false, issues: ['Check the source'] });
    const revise = vi.fn().mockResolvedValue({ ...draft, checks: [{ check: 'Unsupported assertion', factIds: ['invented'] }] });
    const result = await generateCourseSkillDrafts({ ...deps, audit, revise }, [chunk]);
    expect(revise).toHaveBeenCalledTimes(2);
    expect(audit).toHaveBeenCalledTimes(1);
    expect(result.candidates[0].draft).toEqual(draft);
    expect(result.candidates[0].issues).toEqual(expect.arrayContaining(['SKILL_AUTO_REPAIR_INVALID', 'SKILL_AUTO_REPAIR_EXHAUSTED']));
    expect(result.candidates[0].generationRepair?.attempts.map(a => a.status)).toEqual(['invalid', 'invalid']);
  });
  it('propagates unexpected repair errors instead of treating them as source validation issues', async () => {
    const error = new TypeError('Unexpected programming failure');
    await expect(generateCourseSkillDrafts({ ...deps, audit: async () => ({ supported: false, issues: [] }), revise: async () => { throw error; } }, [chunk])).rejects.toBe(error);
  });
  it.each(['SKILL_INPUT_CHANGED', 'SKILL_QUOTA_EXCEEDED', 'SKILL_USAGE_RECORD_FAILED', 'Unexpected internal failure'])('propagates %s from initial repair', async message => {
    const invalid = { ...draft, doNotUseWhen: ['Invented exclusion'] };
    const error = new Error(message);
    await expect(generateCourseSkillDrafts({ ...deps, synthesize: async () => invalid, revise: async () => { throw error; } }, [chunk])).rejects.toBe(error);
  });
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
