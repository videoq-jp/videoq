import { describe, expect, it, vi } from 'vitest';
import { runCourseSkillBuild, SkillStepBudgetExceeded, type SkillExecutionDependencies, type SkillExecutionState } from '../src/features/course-skills/execution-service';

function fixture(checkpoint = '') {
  const input = { ownerId: 'owner', courseId: 1, generationEpoch: 1, settings: { generationEnabled: true, distributionEnabled: false, policyVersion: '1', language: 'ja' as const }, sources: [{ membershipId: 1, videoId: 2, title: '講義', status: 'completed', analysisRevision: 'r1', visualRevision: '', ready: true }] };
  const build = { id: 'build', courseId: 1, revision: 1, inputKey: 'hash', input: JSON.stringify(input), state: 'running', leaseToken: 'token', leaseUntil: 1000000, generation: 1, checkpoint };
  const inputs = { configure: vi.fn(), snapshot: vi.fn(), due: vi.fn(), affected: vi.fn(), reconcile: vi.fn(), claim: vi.fn(async () => build), checkpoint: vi.fn(async () => true), complete: vi.fn(async () => true) };
  const execution = { pending: vi.fn(async () => ({ id: 'build', ownerId: 'owner' })), nextWakeup: vi.fn(), current: vi.fn(), release: vi.fn(async () => true), readStep: vi.fn(), saveStep: vi.fn(), progress: vi.fn() };
  const deps: SkillExecutionDependencies = { inputs, execution, id: () => 'token', now: () => 100, extract: vi.fn(async () => ({ status: 'completed', keys: ['knowledge'] })), draft: vi.fn(async () => undefined) };
  return { deps, inputs, execution, build };
}
const planning = (changes: Partial<SkillExecutionState> = {}) => JSON.stringify({ version: 1, phase: 'planning', sourceIndex: 1, knowledgeKeys: ['knowledge'], attempts: 0, modelCalls: 2, ...changes });

describe('durable course skill execution', () => {
  it('checkpoints extracted knowledge and resumes planning before completing', async () => {
    const f = fixture();
    await runCourseSkillBuild(f.deps);
    expect(f.deps.draft).not.toHaveBeenCalled();
    expect(f.inputs.complete).not.toHaveBeenCalled();
    f.build.checkpoint = f.execution.release.mock.calls[0][1];
    expect(JSON.parse(f.build.checkpoint)).toMatchObject({ phase: 'planning', knowledgeKeys: ['knowledge'], sourceIndex: 1 });
    await runCourseSkillBuild(f.deps);
    expect(f.deps.draft).toHaveBeenCalledOnce();
    expect(f.inputs.complete).toHaveBeenCalledOnce();
    expect(JSON.parse(f.inputs.checkpoint.mock.calls[0][4])).toMatchObject({ phase: 'review_required' });
  });
  it('yields for the model budget without counting a transient failure', async () => {
    const f = fixture(planning());
    f.deps.draft = vi.fn(async (_lease, _input, _keys, budget) => { budget.spent++; throw new SkillStepBudgetExceeded(); });
    await runCourseSkillBuild(f.deps);
    expect(JSON.parse(f.execution.release.mock.calls[0][1])).toMatchObject({ phase: 'planning', attempts: 0, modelCalls: 3 });
    expect(f.execution.release.mock.calls[0][2]).toBe('queued');
    expect(f.inputs.complete).not.toHaveBeenCalled();
  });
  it('fails a corrupt checkpoint without calling a model or exposing its contents', async () => {
    const f = fixture('{private-invalid');
    await expect(runCourseSkillBuild(f.deps)).resolves.toMatchObject({ failed: true });
    expect(f.deps.extract).not.toHaveBeenCalled();
    expect(f.execution.release.mock.calls[0][1]).not.toContain('private-invalid');
    expect(JSON.parse(f.execution.release.mock.calls[0][1])).toMatchObject({ error: 'SKILL_INVALID_EXECUTION_INPUT' });
  });
  it('caps total model calls and sanitizes provider failures', async () => {
    const f = fixture(planning({ modelCalls: 1000 }));
    f.deps.draft = vi.fn(async (_lease, _input, _keys, budget) => { expect(budget.maximum).toBe(0); throw new SkillStepBudgetExceeded(); });
    await expect(runCourseSkillBuild(f.deps)).resolves.toMatchObject({ failed: true });
    expect(JSON.parse(f.execution.release.mock.calls[0][1])).toMatchObject({ error: 'SKILL_BUILD_BUDGET_EXHAUSTED' });
    const retry = fixture(planning({ attempts: 4 }));
    retry.deps.draft = vi.fn(async () => { throw new Error('provider private response'); });
    await expect(runCourseSkillBuild(retry.deps)).resolves.toMatchObject({ failed: true });
    expect(retry.execution.release.mock.calls[0][1]).not.toContain('provider private');
  });
  it('does not complete after losing the source fence', async () => {
    const f = fixture(planning());
    f.inputs.checkpoint.mockResolvedValue(false);
    await runCourseSkillBuild(f.deps);
    expect(f.inputs.complete).not.toHaveBeenCalled();
  });
});
