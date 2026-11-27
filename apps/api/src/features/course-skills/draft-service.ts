import type { SkillDraft } from '@videoq/domain/agent-skills';
import type { SkillKnowledgeChunk } from '../../domain/learning/skill-knowledge';
import { supportedSkillFacts, validateSkillDraft, type SkillTask, type SkillTaskProposal, type SupportedSkillFact } from '../../domain/learning/course-skill-draft';

export interface SkillDraftDependencies {
  id(): string;
  plan(facts: SupportedSkillFact[], existing: SkillTask[]): Promise<{ proposals: SkillTaskProposal[]; issues: string[] }>;
  synthesize(task: SkillTask, facts: SupportedSkillFact[]): Promise<SkillDraft>;
  audit(draft: SkillDraft, facts: SupportedSkillFact[]): Promise<{ supported: boolean; issues: string[] }>;
}

export async function generateCourseSkillDrafts(deps: SkillDraftDependencies, chunks: SkillKnowledgeChunk[], existing: SkillTask[] = [], options: { force?: boolean } = {}) {
  const facts = supportedSkillFacts(chunks);
  const byId = new Map(facts.map(f => [f.id, f]));
  const tasks = new Map(existing.map(t => [t.skillId, { ...t, factIds: t.factIds.filter(id => byId.has(id)) }]));
  const issues: string[] = [];
  const touched = new Set(existing.filter(t => options.force || t.factIds.some(id => !byId.has(id))).map(t => t.skillId));
  // Planning reads bounded pages; task identity is server-assigned or explicitly retained.
  for (let start = 0; start < facts.length; start += 32) {
    const page = facts.slice(start, start + 32);
    const plan = await deps.plan(page, [...tasks.values()]);
    issues.push(...plan.issues);
    const pageIds = new Set(page.map(f => f.id));
    for (const proposal of plan.proposals) {
      if (!proposal.objective.trim() || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(proposal.slug) || proposal.slug.length > 40 || !proposal.factIds.length || proposal.factIds.some(id => !pageIds.has(id))) throw new Error('INVALID_SKILL_PLAN');
      if (proposal.existingSkillId && !tasks.has(proposal.existingSkillId)) throw new Error('INVALID_SKILL_IDENTITY');
      const sameSlug = [...tasks.values()].find(t => t.slug === proposal.slug);
      const skillId = proposal.existingSkillId ?? sameSlug?.skillId ?? deps.id();
      if (!proposal.existingSkillId && !sameSlug && tasks.has(skillId)) throw new Error('SKILL_ID_COLLISION');
      const previous = tasks.get(skillId);
      tasks.set(skillId, { skillId, slug: previous?.slug ?? proposal.slug, objective: proposal.objective, factIds: [...new Set([...(previous?.factIds ?? []), ...proposal.factIds])] });
      if (!previous || proposal.factIds.some(id => !previous.factIds.includes(id))) touched.add(skillId);
    }
  }
  const candidates: { task: SkillTask; draft: SkillDraft | null; facts: SupportedSkillFact[]; issues: string[] }[] = [];
  for (const task of tasks.values()) {
    if (!touched.has(task.skillId)) continue;
    const taskFacts = task.factIds.map(id => byId.get(id)!).filter(Boolean);
    if (!taskFacts.some(f => f.kind === 'procedure') || !taskFacts.some(f => f.kind === 'verification') || !taskFacts.some(f => f.kind === 'criterion' || f.kind === 'principle')) {
      candidates.push({ task, draft: null, facts: taskFacts, issues: ['SKILL_INSUFFICIENT_TASK_KNOWLEDGE'] });
      continue;
    }
    // Never silently truncate applicable conditions to meet a model context budget.
    if (JSON.stringify(taskFacts).length > 100_000) { candidates.push({ task, draft: null, facts: taskFacts, issues: ['SKILL_TASK_REQUIRES_SPLITTING'] }); continue; }
    const draft = await deps.synthesize(task, taskFacts);
    if (draft.slug !== task.slug) throw new Error('INVALID_SKILL_IDENTITY');
    validateSkillDraft(draft, taskFacts);
    const audit = await deps.audit(draft, taskFacts);
    candidates.push({ task, draft, facts: taskFacts, issues: audit.supported ? audit.issues : [...audit.issues, 'SKILL_SEMANTIC_REVIEW_REQUIRED'] });
  }
  return { candidates, issues, heldVisualFacts: chunks.flatMap(c => c.facts).filter(f => f.status === 'needs_visual_review').length };
}
