import type { CourseSkillInputRepository, CourseSkillSettings, CourseSkillSource } from '../../persistence/contracts/course-skill-input-repository';
import type { CourseSkillExecutionRepository } from '../../persistence/contracts/course-skill-execution-repository';
import type { SkillBuildLease } from '../../persistence/contracts/course-skill-knowledge-repository';

export class SkillStepBudgetExceeded extends Error {}
export type SkillRunBudget = { spent: number; maximum: number };
export type SkillExecutionInput = { courseId: number; ownerId: string; generationEpoch: number; settings: CourseSkillSettings; sources: CourseSkillSource[] };
export type SkillExecutionState = { version: 1; phase: 'extracting' | 'planning' | 'review_required'; sourceIndex: number; knowledgeKeys: string[]; attempts: number; modelCalls: number; error?: string };
export interface SkillExecutionDependencies {
  inputs: CourseSkillInputRepository;
  execution: CourseSkillExecutionRepository;
  id(): string;
  now(): number;
  extract(lease: SkillBuildLease, input: SkillExecutionInput, source: CourseSkillSource, budget: SkillRunBudget): Promise<{ status: 'completed' | 'budget_exhausted'; keys: string[] }>;
  draft(lease: SkillBuildLease, input: SkillExecutionInput, keys: string[], budget: SkillRunBudget): Promise<void>;
}

export async function runCourseSkillBuild(deps: SkillExecutionDependencies) {
  const pending = await deps.execution.pending(deps.now());
  if (!pending) return { claimed: 0 };
  const token = deps.id();
  const build = await deps.inputs.claim(pending.id, pending.ownerId, token, deps.now(), 900_000);
  if (!build) return { claimed: 0 };
  const lease = { id: build.id, ownerId: pending.ownerId, token, generation: build.generation };
  let state: SkillExecutionState = { version: 1, phase: 'extracting', sourceIndex: 0, knowledgeKeys: [], attempts: 0, modelCalls: 0 };
  const budget = { spent: 0, maximum: 1 };
  let failure: unknown;
  try {
    if (build.checkpoint) {
      let stored: SkillExecutionState;
      try { stored = JSON.parse(build.checkpoint) as SkillExecutionState; } catch { throw new Error('SKILL_INVALID_EXECUTION_INPUT'); }
      if (stored?.version !== 1 || !['extracting', 'planning', 'review_required'].includes(stored.phase) || !Number.isSafeInteger(stored.sourceIndex) || stored.sourceIndex < 0 || !Number.isSafeInteger(stored.attempts) || stored.attempts < 0 || !Number.isSafeInteger(stored.modelCalls) || stored.modelCalls < 0 || !Array.isArray(stored.knowledgeKeys) || stored.knowledgeKeys.some(k => typeof k !== 'string')) throw new Error('SKILL_INVALID_EXECUTION_INPUT');
      state = stored;
    }
    budget.maximum = Math.max(0, Math.min(1, 1000 - state.modelCalls));
    let input: SkillExecutionInput;
    try { input = JSON.parse(build.input) as SkillExecutionInput; } catch { throw new Error('SKILL_INVALID_EXECUTION_INPUT'); }
    if (input.ownerId !== pending.ownerId || input.courseId !== build.courseId || state.version !== 1 || !Number.isSafeInteger(state.sourceIndex) || !Array.isArray(state.knowledgeKeys)) throw new Error('SKILL_INVALID_EXECUTION_INPUT');
    if (state.phase === 'extracting') {
      const source = input.sources[state.sourceIndex];
      if (source) {
        const result = await deps.extract(lease, input, source, budget);
        state.knowledgeKeys = [...new Set([...state.knowledgeKeys, ...result.keys])];
        if (result.status === 'completed') state.sourceIndex++;
      }
      if (state.sourceIndex >= input.sources.length) state.phase = 'planning';
    } else if (state.phase === 'planning') {
      await deps.draft(lease, input, state.knowledgeKeys, budget);
      state.phase = 'review_required';
    }
    state.attempts = 0;
    delete state.error;
  } catch (error) { failure = error; }
  state.modelCalls += budget.spent;
  if (failure && !(failure instanceof SkillStepBudgetExceeded)) {
    state.attempts++;
    state.error = failure instanceof Error && ['SKILL_QUOTA_EXCEEDED', 'SKILL_INVALID_EXECUTION_INPUT'].includes(failure.message) ? failure.message : 'SKILL_GENERATION_FAILED';
  }
  if (failure instanceof SkillStepBudgetExceeded && state.modelCalls >= 1000) state.error = 'SKILL_BUILD_BUDGET_EXHAUSTED';
  const failed = state.attempts >= 5 || ['SKILL_QUOTA_EXCEEDED', 'SKILL_BUILD_BUDGET_EXHAUSTED', 'SKILL_INVALID_EXECUTION_INPUT'].includes(state.error ?? '');
  const checkpoint = JSON.stringify(state);
  if (!failure && state.phase === 'review_required') {
    if (await deps.inputs.checkpoint(build.id, pending.ownerId, token, build.generation, checkpoint, deps.now())) await deps.inputs.complete(build.id, pending.ownerId, token, build.generation, deps.now());
  } else {
    const delay = failure && !(failure instanceof SkillStepBudgetExceeded) ? Math.min(900_000, 5000 * 2 ** state.attempts) : 1000;
    await deps.execution.release(lease, checkpoint, failed ? 'failed' : 'queued', deps.now(), delay);
  }
  return { claimed: 1, phase: state.phase, failed };
}
