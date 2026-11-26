import type { SkillDraft, SkillPlan } from '@videoq/domain/agent-skills';
import type { AgentSkillState, SkillFact } from './model';
import { nextFactBatch } from './batches';
export const MAX_SKILL_SYNTHESIS_ATTEMPTS = 3;
export class SkillLifecycleError extends Error {
  constructor(message: string, readonly conflict = false) { super(message); }
}
export type SkillStep =
  | { kind: 'extract'; index: number }
  | { kind: 'plan'; offset: number }
  | { kind: 'synthesizeMember' | 'auditMember'; index: number }
  | { kind: 'synthesize' | 'audit' | 'idle' };
export function nextSkillStep(state: AgentSkillState): SkillStep {
  if (state.stage === 'extracting') return { kind: 'extract', index: state.completedChunks };
  if (state.stage === 'planning') return { kind: 'plan', offset: state.plannedFacts ?? 0 };
  if (state.automatic && (state.stage === 'synthesizing' || state.stage === 'auditing')) {
    const index = state.members?.findIndex(item => item.status === 'pending' || item.status === 'auditing') ?? -1;
    if (index < 0) throw new SkillLifecycleError('Missing skill plan.');
    return { kind: state.members![index].status === 'pending' ? 'synthesizeMember' : 'auditMember', index };
  }
  if (state.stage === 'synthesizing') return { kind: 'synthesize' };
  if (state.stage === 'auditing') return { kind: 'audit' };
  return { kind: 'idle' };
}
export type SkillStepResult =
  | { kind: 'extract'; facts: SkillFact[] }
  | { kind: 'plan'; plan: SkillPlan; count: number }
  | { kind: 'synthesizeMember'; index: number; draft: SkillDraft }
  | { kind: 'auditMember'; index: number; issues: string[]; count: number }
  | { kind: 'synthesize'; draft: SkillDraft }
  | { kind: 'audit'; issues: string[] };
/** Return a new state; external execution and durable save happen in the use case. */
export function completeSkillStep(previous: AgentSkillState, result: SkillStepResult): AgentSkillState {
  const step = nextSkillStep(previous);
  if (step.kind !== result.kind || ('index' in step && 'index' in result && step.index !== result.index)) throw new SkillLifecycleError('Skill progress changed. Reload before retrying.', true);
  const state = { ...previous, facts: [...previous.facts], issues: [...previous.issues],
    members: previous.members?.map(member => ({ ...member, issues: [...member.issues] })) };
  switch (result.kind) {
    case 'extract':
      state.facts.push(...result.facts); state.completedChunks++;
      if (state.completedChunks === state.chunks.length) {
        if (!state.facts.length) { state.stage = 'rejected'; state.issues = ['No actionable knowledge for this task was found in the source material.']; }
        else { if (nextFactBatch(state.facts, 0).length < state.facts.length) state.automatic = true; state.stage = state.automatic ? 'planning' : 'synthesizing'; }
      }
      break;
    case 'plan':
      state.members ??= [];
      for (const skill of result.plan.skills) state.members.push({ ...skill, key: (state.members.length + 1).toString(36), draft: null, status: 'pending', issues: [] });
      state.plannedFacts = (state.plannedFacts ?? 0) + result.count;
      if (state.plannedFacts === state.facts.length) state.stage = 'synthesizing';
      break;
    case 'synthesizeMember': {
      const member = state.members![result.index];
      if (!member.key && state.members!.some(other => other !== member && other.draft?.slug === result.draft.slug)) throw new SkillLifecycleError('Generated skills have duplicate names. Retry synthesis.');
      member.draft = result.draft; member.attempts = (member.attempts ?? 0) + 1;
      member.issues = []; member.auditCursor = 0; member.status = 'auditing'; state.stage = 'auditing'; break;
    }
    case 'auditMember': {
      const member = state.members![result.index];
      member.issues.push(...result.issues); member.auditCursor = (member.auditCursor ?? 0) + result.count;
      if (member.auditCursor < state.facts.length && !member.issues.length) break;
      member.status = member.issues.length ? ((member.attempts ?? 1) < MAX_SKILL_SYNTHESIS_ATTEMPTS ? 'pending' : 'rejected') : 'passed';
      if (state.members!.some(item => item.status === 'pending')) state.stage = 'synthesizing';
      else if (state.members!.some(item => item.status === 'auditing')) state.stage = 'auditing';
      else {
        state.issues = state.members!.flatMap(item => item.issues.map(issue => `${item.objective}: ${issue}`));
        state.stage = state.members!.every(item => item.status === 'passed' && item.draft) ? 'published' : 'rejected';
      }
      break;
    }
    case 'synthesize': state.draft = result.draft; state.stage = 'auditing'; break;
    case 'audit': state.issues = result.issues; state.stage = state.issues.length ? 'rejected' : 'review'; break;
  }
  return state;
}
export function publishSkill(state: AgentSkillState): AgentSkillState {
  if (state.stage === 'published') return state;
  if (state.stage !== 'review') throw new SkillLifecycleError('Only a checked draft can be published.', true);
  return { ...state, stage: 'published' };
}
export function checkedSkillBundleMembers(state: AgentSkillState) {
  if (state.stage !== 'published') throw new SkillLifecycleError('Generate and publish a checked skill set in VideoQ before installing it.', true);
  if (state.automatic && (!state.members?.length || state.members.some(member => member.status !== 'passed' || !member.draft))) throw new SkillLifecycleError('The skill set has not passed every source check.', true);
  return state.members;
}
export function skillBundlePage(total: number, page?: { offset: number; limit: number }) {
  const offset = page?.offset ?? 0, end = Math.min(total, offset + (page?.limit ?? total));
  if (offset >= total) throw new SkillLifecycleError('Invalid skill page.');
  return { offset, end };
}

export function initialSkillState(input: Pick<AgentSkillState, 'target' | 'language' | 'resourceTitle' | 'fingerprint' | 'chunks' | 'sourceVideos'> & { objective?: string }): AgentSkillState {
  return { ...input, version: 1, plannedFacts: 0, objective: input.objective ?? '', automatic: !input.objective,
    stage: 'extracting', completedChunks: 0, facts: [], draft: null, issues: [] };
}
