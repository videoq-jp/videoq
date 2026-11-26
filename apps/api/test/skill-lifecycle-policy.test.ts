import { expect, it } from 'vitest';
import { initialSkillState, completeSkillStep, nextSkillStep, checkedSkillBundleMembers, publishSkill } from '../src/domain/skills/lifecycle';
import { generatedSkillDraft } from './fixtures/agent-skill';
const base = () => initialSkillState({ target: { kind: 'course', resourceId: 1 }, language: 'en', resourceTitle: 'Course', fingerprint: 'source', chunks: [[]], sourceVideos: 1 });
it('requires every automatic member to pass before publishing, including a second pending audit', () => {
  const state = { ...base(), stage: 'auditing' as const, members: [0, 1].map(i => ({ objective: `Task ${i}`, factIds: [], draft: generatedSkillDraft, key: `${i}`, status: 'auditing' as const, issues: [] })) };
  const first = completeSkillStep(state, { kind: 'auditMember', index: 0, count: 0, issues: [] });
  expect(first.stage).toBe('auditing');
  expect(state.members[0].status).toBe('auditing');
  const final = completeSkillStep(first, { kind: 'auditMember', index: 1, count: 0, issues: [] });
  expect(final.stage).toBe('published');
  expect(checkedSkillBundleMembers(final)).toHaveLength(2);
});
it('bounds retries and rejects a result from another state without changing the original', () => {
  const state = { ...base(), stage: 'auditing' as const, members: [{ objective: 'Task', factIds: [], draft: generatedSkillDraft, status: 'auditing' as const, issues: [], attempts: 3 }] };
  const failed = completeSkillStep(state, { kind: 'auditMember', index: 0, count: 0, issues: ['unsupported'] });
  expect(failed.stage).toBe('rejected');
  expect(() => checkedSkillBundleMembers(failed)).toThrow();
  expect(() => completeSkillStep(state, { kind: 'synthesize', draft: generatedSkillDraft })).toThrow(/changed/);
  expect(nextSkillStep(state)).toEqual({ kind: 'auditMember', index: 0 });
  expect(() => publishSkill(state)).toThrow(/checked draft/);
});
