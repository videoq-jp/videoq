import { expect, it } from 'vitest';
import { generateCourseSkillDrafts } from '../src/features/course-skills/draft-service';
import { courseSkillDraftDependencies } from '../src/integrations/course-skill-drafts';
import type { generateCourseSkillJson } from '../src/integrations/course-skill-model';
import type { SupportedSkillFact } from '../src/domain/learning/course-skill-draft';
import type { Bindings } from '../src/types/bindings';

const facts = ['principle', 'procedure', 'verification'].map((kind, i) => ({ id: `fact-${i}`, kind, claim: 'Retry guarantees', appliesWhen: [], exceptions: kind === 'principle' ? ['External effect'] : [], evidence: [], requiresVisualEvidence: false, versionContext: { language: null, framework: null, version: null }, status: 'supported', videoId: 1, analysisRevision: 'r1', cues: [] })) as SupportedSkillFact[];
const proposal = { existingSkillId: null as string | null, slug: 'review-retry', objective: 'Review retries', criterionFactIds: ['f0'], procedureFactIds: ['f1'], verificationFactIds: ['f2'], additionalFactIds: [] };
function adapter(value: typeof proposal, count = 1) {
  const generate: typeof generateCourseSkillJson = async (_env, _owner, options) => options.schema.parse({ proposals: Array.from({ length: count }, () => value), issues: [] });
  return courseSkillDraftDependencies({} as Bindings, 'owner', 'ja', generate);
}
it('plans a new task with null when there is no existing inventory', async () => {
  expect((await adapter(proposal).plan(facts, [])).proposals[0]).toMatchObject({ existingSkillId: null, factIds: ['fact-0', 'fact-1', 'fact-2'] });
});
it.each(['', 'invented-skill'])('rejects an existing ID %j when no existing task was supplied', async existingSkillId => {
  await expect(adapter({ ...proposal, existingSkillId }).plan(facts, [])).rejects.toThrow();
});
it('allows only supplied existing task IDs and known source references', async () => {
  const existing = [{ skillId: 'known-task', slug: 'review-retry', objective: 'Review retries', factIds: [] }];
  expect((await adapter({ ...proposal, existingSkillId: 'known-task' }).plan(facts, existing)).proposals[0].existingSkillId).toBe('known-task');
  await expect(adapter({ ...proposal, existingSkillId: 'other-task' }).plan(facts, existing)).rejects.toThrow();
  await expect(adapter({ ...proposal, criterionFactIds: ['f99'] }).plan(facts, existing)).rejects.toThrow();
});

it('bounds each planning call without inventing extra task capacity', async () => {
  await expect(adapter(proposal, 5).plan(facts, [])).rejects.toThrow();
});

it('bounds overlong proposed names without merging distinct task names', async () => {
  const a = (await adapter({ ...proposal, slug: 'deterministic-testing-with-ambiguous-object' }).plan(facts, [])).proposals[0].slug;
  const b = (await adapter({ ...proposal, slug: 'deterministic-testing-with-ambiguous-result' }).plan(facts, [])).proposals[0].slug;
  expect(a.length).toBeLessThanOrEqual(40);
  expect(a).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
  expect(a).not.toBe(b);
  expect((await adapter({ ...proposal, slug: 'deterministic-testing-with-ambiguous-object' }).plan(facts, [])).proposals[0].slug).toBe(a);
});

const wireDraft = { slug: 'review-retry', title: 'Review retries', description: 'Inspect retry guarantees.', useWhen: ['Changing retries'], doNotUseWhen: [], criteria: [{ decision: 'Establish identity', factIds: ['f0'] }], steps: [{ action: 'Inspect the request', expectedResult: 'Known identity', factIds: ['f1'] }], exceptions: [{ condition: 'External effect', behavior: 'Check external guarantees', factIds: ['f0'] }], checks: [{ check: 'Repeat concurrently', factIds: ['f2'] }], examples: [{ situation: 'Repeat request', application: 'Keep identity', factIds: ['f1'] }] };
it('round-trips compact model references while preserving stored source IDs', async () => {
  const generate: typeof generateCourseSkillJson = async (_env, _owner, options) => {
    const input = options.input as { facts: { id: string }[]; task?: { factIds: string[] }; draft?: typeof wireDraft };
    expect(input.facts.map(f => f.id)).toEqual(['f0', 'f1', 'f2']);
    if (options.name === 'skill_draft_audit') {
      expect(input.draft!.checks[0].factIds).toEqual(['f2']);
      return options.schema.parse({ supported: true, issues: [] });
    }
    expect(input.task!.factIds).toEqual(['f0', 'f1', 'f2']);
    return options.schema.parse(wireDraft);
  };
  const deps = courseSkillDraftDependencies({} as Bindings, 'owner', 'ja', generate);
  const draft = await deps.synthesize({ skillId: 'task', slug: 'review-retry', objective: 'Review retries', factIds: facts.map(f => f.id) }, facts);
  expect(draft.criteria[0].factIds).toEqual(['fact-0']);
  expect(draft.steps[0].factIds).toEqual(['fact-1']);
  expect(draft.exceptions[0].factIds).toEqual(['fact-0']);
  expect(draft.examples[0].factIds).toEqual(['fact-1']);
  expect(draft.checks[0].factIds).toEqual(['fact-2']);
  expect((await deps.audit(draft, facts)).supported).toBe(true);
  expect(facts.map(f => f.id)).toEqual(['fact-0', 'fact-1', 'fact-2']);
});
it('rejects model references outside the current alias map', async () => {
  const generate: typeof generateCourseSkillJson = async (_env, _owner, options) => options.schema.parse({ ...wireDraft, checks: [{ check: 'Unknown source', factIds: ['f99'] }] });
  const deps = courseSkillDraftDependencies({} as Bindings, 'owner', 'ja', generate);
  await expect(deps.synthesize({ skillId: 'task', slug: 'review-retry', objective: 'Review retries', factIds: facts.map(f => f.id) }, facts)).rejects.toThrow('SKILL_UNSUPPORTED_FACT');
});
it('rejects unknown stored references before invoking the audit model', async () => {
  let calls = 0;
  const generate: typeof generateCourseSkillJson = async (_env, _owner, options) => { calls++; return options.schema.parse({ supported: true, issues: [] }); };
  const deps = courseSkillDraftDependencies({} as Bindings, 'owner', 'ja', generate);
  await expect(deps.audit({ ...wireDraft, checks: [{ check: 'Other source', factIds: ['other-source'] }] }, facts)).rejects.toThrow('SKILL_UNSUPPORTED_FACT');
  expect(calls).toBe(0);
});

it('retains a partial task even when the same page has unrelated verification', async () => {
  const result = await adapter({ ...proposal, verificationFactIds: [] }).plan(facts, []);
  expect(result.proposals[0].factIds).toEqual(['fact-0', 'fact-1']);
});

it('holds a task when model role buckets do not match actual source kinds', async () => {
  const deps = adapter({ ...proposal, criterionFactIds: ['f1'] });
  const result = await generateCourseSkillDrafts({ id: () => 'task', plan: deps.plan,
    synthesize: () => Promise.reject(new Error('Incomplete task must not be synthesized')),
    audit: () => Promise.resolve({ supported: true, issues: [] }),
  }, [{ version: 1, videoId: 1, analysisRevision: 'r1', chunkIndex: 0, cues: [], facts, model: 'fixture', promptVersion: '1' }]);
  expect(result.candidates[0].draft).toBeNull();
  expect(result.candidates[0].issues).toContain('SKILL_INSUFFICIENT_TASK_KNOWLEDGE');
});

it('bounds unsourced exclusions and exceptions before caching a model result', async () => {
  const generate: typeof generateCourseSkillJson = async (_env, _owner, options) => options.schema.parse(wireDraft);
  const deps = courseSkillDraftDependencies({} as Bindings, 'owner', 'ja', generate);
  const plain = facts.map(f => ({ ...f, exceptions: [] }));
  await expect(deps.synthesize({ skillId: 'task', slug: 'review-retry', objective: 'Review retries', factIds: plain.map(f => f.id) }, plain)).rejects.toThrow();
});
