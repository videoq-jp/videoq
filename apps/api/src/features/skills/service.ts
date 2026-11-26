import { initialSkillState, nextSkillStep, completeSkillStep, publishSkill, checkedSkillBundleMembers, skillBundlePage, SkillLifecycleError, type SkillStepResult } from '../../domain/skills/lifecycle';
import type { SkillAudit, SkillDraft, ExtractedFacts, SkillPlan } from '@videoq/domain/agent-skills';
import type { AgentSkillRepository} from '../../persistence/contracts/agent-skill-repository';
import type { SkillTarget, SkillMaterial, SkillCue, SkillFact, AgentSkillRecord } from '../../domain/skills/model';
import { nextFactBatch } from '../../domain/skills/batches';
import { conflict, notFound, validationFailure } from '../../application/errors';
import { skillChunks, checkedPlan, checkedFacts, checkedDraft, auditIssues, renderSkill, skillView } from './core';

export interface SkillCancellation { throwIfAborted(): void }
export interface SkillDependencies<Signal extends SkillCancellation = SkillCancellation> {
  repository: AgentSkillRepository;
  material(ownerId: string, target: SkillTarget): Promise<SkillMaterial>;
  fingerprint(material: SkillMaterial): Promise<string>;
  newId(): string; now(): number;
  extract(ownerId: string, objective: string, language: 'ja' | 'en', cues: SkillCue[], signal?: Signal): Promise<ExtractedFacts>;
  synthesize(ownerId: string, objective: string, language: 'ja' | 'en', facts: SkillFact[], signal?: Signal, revision?: { draft: SkillDraft; issues: string[] }): Promise<SkillDraft>;
  plan(ownerId: string, language: 'ja' | 'en', facts: SkillFact[], signal?: Signal): Promise<SkillPlan>;
  audit(ownerId: string, objective: string, draft: SkillDraft, facts: SkillFact[], signal?: Signal, courseFacts?: SkillFact[]): Promise<SkillAudit>;
}

export function createSkillService<Signal extends SkillCancellation = SkillCancellation>(deps: SkillDependencies<Signal>, origin: string) {
  function decision<Result>(evaluate: () => Result): Result {
    try { return evaluate(); }
    catch (error) { if (error instanceof SkillLifecycleError) throw error.conflict ? conflict(error.message) : validationFailure(error.message); throw error; }
  }

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
      const record: AgentSkillRecord = { id: deps.newId(), ownerId, state: initialSkillState({
        target: { kind: input.kind, resourceId: input.resourceId }, objective: input.objective, language: input.language,
        resourceTitle: material.title, fingerprint: await deps.fingerprint(material), chunks, sourceVideos: material.sources.length,
      }) };
      await deps.repository.create(record);
      return skillView(record, origin);
    },
    async get(ownerId: string, id: string) { return skillView(await current(ownerId, id), origin); },
    async advance(ownerId: string, id: string, signal?: Signal) {
      return locked(ownerId, id, async (record, token) => {
        const state = record.state;
        signal?.throwIfAborted();
        const step = decision(() => nextSkillStep(state));
        let result: SkillStepResult;
        switch (step.kind) {
          case 'idle': return;
          case 'extract': {
            const cues = state.chunks[step.index];
            result = { kind: 'extract', facts: checkedFacts(await deps.extract(ownerId, state.objective, state.language, cues, signal), cues, step.index) }; break;
          }
          case 'plan': {
            const batch = nextFactBatch(state.facts, step.offset);
            result = { kind: 'plan', count: batch.length, plan: checkedPlan(await deps.plan(ownerId, state.language, batch, signal), batch) }; break;
          }
          case 'synthesizeMember': {
            const member = state.members![step.index], facts = state.facts.filter(fact => member.factIds.includes(fact.id));
            const draft = checkedDraft(await deps.synthesize(ownerId, member.objective, state.language, facts, signal, member.draft && member.issues.length ? { draft: member.draft, issues: member.issues } : undefined), facts);
            result = { kind: 'synthesizeMember', index: step.index, draft }; break;
          }
          case 'auditMember': {
            const member = state.members![step.index], facts = state.facts.filter(fact => member.factIds.includes(fact.id));
            if (!member.draft) throw validationFailure('Missing generated draft.');
            const context = nextFactBatch(state.facts, member.auditCursor ?? 0);
            result = { kind: 'auditMember', index: step.index, count: context.length,
              issues: auditIssues(await deps.audit(ownerId, member.objective, member.draft, facts, signal, context), member.draft) }; break;
          }
          case 'synthesize': result = { kind: 'synthesize', draft: checkedDraft(await deps.synthesize(ownerId, state.objective, state.language, state.facts, signal), state.facts) }; break;
          case 'audit':
            if (!state.draft) throw validationFailure('Missing generated draft.');
            result = { kind: 'audit', issues: auditIssues(await deps.audit(ownerId, state.objective, state.draft, state.facts, signal), state.draft) }; break;
        }
        record.state = decision(() => completeSkillStep(state, result));
        signal?.throwIfAborted();
        await persist(record, token);
      });
    },
    async publish(ownerId: string, id: string) {
      return locked(ownerId, id, async (record, token) => {
        const next = decision(() => publishSkill(record.state));
        if (next === record.state) return;
        record.state = next;
        await persist(record, token);
      });
    },
    async bundle(ownerId: string, id: string, page?: { offset: number; limit: number }) {
      const record = await current(ownerId, id);
      const members = decision(() => checkedSkillBundleMembers(record.state));
      if (record.state.automatic) {
        const { offset, end } = decision(() => skillBundlePage(members!.length, page));
        const skills = members!.slice(offset, end).map(member => renderSkill({ ...record, state: { ...record.state, draft: member.draft } }, origin, member.key));
        return { ...skills[0], skills, ...(page ? { nextOffset: end < members!.length ? end : null, totalSkills: members!.length } : {}) };
      }
      return renderSkill(record, origin);
    },
  };
}
