import type { SkillAudit, SkillDraft, ExtractedFacts, SkillPlan } from '@videoq/trpc/skills';
import type { AgentSkillRepository, SkillTarget, SkillMaterial, SkillCue, SkillFact, AgentSkillRecord } from '../../persistence/contracts/agent-skill-repository';
import { nextFactBatch } from './batches';
import { conflict, notFound, validationFailure } from '../../application/errors';
import { skillChunks, checkedPlan, checkedFacts, checkedDraft, auditIssues, renderSkill, skillView } from './core';

export interface SkillDependencies {
  repository: AgentSkillRepository;
  material(ownerId: string, target: SkillTarget): Promise<SkillMaterial>;
  fingerprint(material: SkillMaterial): Promise<string>;
  newId(): string; now(): number;
  extract(ownerId: string, objective: string, language: 'ja' | 'en', cues: SkillCue[], signal?: AbortSignal): Promise<ExtractedFacts>;
  synthesize(ownerId: string, objective: string, language: 'ja' | 'en', facts: SkillFact[], signal?: AbortSignal, revision?: { draft: SkillDraft; issues: string[] }): Promise<SkillDraft>;
  plan(ownerId: string, language: 'ja' | 'en', facts: SkillFact[], signal?: AbortSignal): Promise<SkillPlan>;
  audit(ownerId: string, objective: string, draft: SkillDraft, facts: SkillFact[], signal?: AbortSignal, courseFacts?: SkillFact[]): Promise<SkillAudit>;
}

export function createSkillService(deps: SkillDependencies, origin: string) {
  async function current(ownerId: string, id: string) {
    const record = await deps.repository.get(id, ownerId);
    if (!record) throw notFound('Skill not found.');
    const material = await deps.material(ownerId, record.state.target);
    if (await deps.fingerprint(material) !== record.state.fingerprint) throw conflict('Source videos changed. Generate a new skill from the updated material.', 'SKILL_SOURCE_CHANGED');
    return record;
  }
  async function locked(ownerId: string, id: string, operation: (record: AgentSkillRecord, token: string) => Promise<void>) {
    const token = deps.newId(), now = deps.now();
    if (!await deps.repository.claim(id, ownerId, token, now, now + 150_000)) throw conflict('This skill is processing another step. Reload its progress before retrying.');
    try {
      const record = await current(ownerId, id);
      await operation(record, token);
      const result = await deps.repository.get(id, ownerId);
      if (!result) throw notFound('Skill not found.');
      return skillView(result, origin);
    } finally { await deps.repository.release(id, ownerId, token); }
  }
  const persist = async (record: AgentSkillRecord, token: string) => {
    if (!await deps.repository.save(record.id, record.ownerId, token, record.state)) throw conflict('Skill processing lease expired. Reload progress before retrying.');
  };
  return {
    async start(ownerId: string, input: SkillTarget & { objective?: string; language: 'ja' | 'en' }) {
      const material = await deps.material(ownerId, input);
      const chunks = skillChunks(material);
      const record: AgentSkillRecord = { id: deps.newId(), ownerId, state: {
        version: 1, plannedFacts: 0, target: { kind: input.kind, resourceId: input.resourceId }, objective: input.objective ?? '', automatic: !input.objective, language: input.language,
        resourceTitle: material.title, fingerprint: await deps.fingerprint(material), stage: 'extracting', chunks,
        completedChunks: 0, sourceVideos: material.sources.length, facts: [], draft: null, issues: [],
      } };
      await deps.repository.create(record);
      return skillView(record, origin);
    },
    async get(ownerId: string, id: string) { return skillView(await current(ownerId, id), origin); },
    async advance(ownerId: string, id: string, signal?: AbortSignal) {
      return locked(ownerId, id, async (record, token) => {
        const state = record.state;
        signal?.throwIfAborted();
        if (state.stage === 'extracting') {
          const cues = state.chunks[state.completedChunks];
          const facts = checkedFacts(await deps.extract(ownerId, state.objective, state.language, cues, signal), cues, state.completedChunks);
          state.facts.push(...facts);
          state.completedChunks++;
          if (state.completedChunks === state.chunks.length) {
            if (!state.facts.length) { state.stage = 'rejected'; state.issues = ['No actionable knowledge for this task was found in the source material.']; }
            else {
              if (nextFactBatch(state.facts, 0).length < state.facts.length) state.automatic = true;
              state.stage = state.automatic ? 'planning' : 'synthesizing';
            }
          }
        } else if (state.stage === 'planning') {
          const offset = state.plannedFacts ?? 0;
          const batch = nextFactBatch(state.facts, offset);
          const plan = checkedPlan(await deps.plan(ownerId, state.language, batch, signal), batch);
          state.members ??= [];
          for (const skill of plan.skills) state.members.push({ ...skill, key: (state.members.length + 1).toString(36), draft: null, status: 'pending', issues: [] });
          state.plannedFacts = offset + batch.length;
          if (state.plannedFacts === state.facts.length) state.stage = 'synthesizing';
        } else if (state.automatic && (state.stage === 'synthesizing' || state.stage === 'auditing')) {
          const member = state.members?.find(item => item.status === 'pending' || item.status === 'auditing');
          if (!member) throw validationFailure('Missing skill plan.');
          const facts = state.facts.filter(fact => member.factIds.includes(fact.id));
          if (member.status === 'pending') {
            const draft = checkedDraft(await deps.synthesize(ownerId, member.objective, state.language, facts, signal, member.draft && member.issues.length ? { draft: member.draft, issues: member.issues } : undefined), facts);
            if (!member.key && state.members?.some(other => other !== member && other.draft?.slug === draft.slug)) throw validationFailure('Generated skills have duplicate names. Retry synthesis.');
            member.draft = draft; member.attempts = (member.attempts ?? 0) + 1; member.issues = []; member.auditCursor = 0; member.status = 'auditing'; state.stage = 'auditing';
          } else {
            if (!member.draft) throw validationFailure('Missing generated draft.');
            const offset = member.auditCursor ?? 0;
            const context = nextFactBatch(state.facts, offset);
            member.issues.push(...auditIssues(await deps.audit(ownerId, member.objective, member.draft, facts, signal, context), member.draft));
            member.auditCursor = offset + context.length;
            if (member.auditCursor < state.facts.length && !member.issues.length) {
              await persist(record, token); return;
            }
            member.status = member.issues.length ? ((member.attempts ?? 1) < 3 ? 'pending' : 'rejected') : 'passed';
            if (state.members?.some(item => item.status === 'pending')) state.stage = 'synthesizing';
            else {
              state.issues = state.members?.flatMap(item => item.issues.map(issue => `${item.objective}: ${issue}`)) ?? [];
              state.stage = state.issues.length ? 'rejected' : 'published';
            }
          }
        } else if (state.stage === 'synthesizing') {
          state.draft = checkedDraft(await deps.synthesize(ownerId, state.objective, state.language, state.facts, signal), state.facts);
          state.stage = 'auditing';
        } else if (state.stage === 'auditing') {
          if (!state.draft) throw validationFailure('Missing generated draft.');
          state.issues = auditIssues(await deps.audit(ownerId, state.objective, state.draft, state.facts, signal), state.draft);
          state.stage = state.issues.length ? 'rejected' : 'review';
        } else return;
        signal?.throwIfAborted();
        await persist(record, token);
      });
    },
    async publish(ownerId: string, id: string) {
      return locked(ownerId, id, async (record, token) => {
        if (record.state.stage === 'published') return;
        if (record.state.stage !== 'review') throw conflict('Only a checked draft can be published.');
        // Fresh source authorization/fingerprint was checked after acquiring the lease.
        record.state.stage = 'published';
        await persist(record, token);
      });
    },
    async bundle(ownerId: string, id: string, page?: { offset: number; limit: number }) {
      const record = await current(ownerId, id);
      if (record.state.stage !== 'published') throw conflict('Generate and publish a checked skill set in VideoQ before installing it.');
      if (record.state.automatic) {
        const members = record.state.members;
        if (!members?.length || members.some(member => member.status !== 'passed' || !member.draft)) throw conflict('The skill set has not passed every source check.');
        const offset = page?.offset ?? 0, end = Math.min(members.length, offset + (page?.limit ?? members.length));
        if (offset >= members.length) throw validationFailure('Invalid skill page.');
        const skills = members.slice(offset, end).map(member => renderSkill({ ...record, state: { ...record.state, draft: member.draft } }, origin, member.key));
        return { ...skills[0], skills, ...(page ? { nextOffset: end < members.length ? end : null, totalSkills: members.length } : {}) };
      }
      return renderSkill(record, origin);
    },
  };
}
