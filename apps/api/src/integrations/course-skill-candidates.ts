import type { Bindings } from '../types/bindings';
import { persistenceBackend } from '../persistence/backend';
import { createSqlCourseSkillCandidateRepository } from '../persistence/course-skill-candidate-sql';
import { createCourseSkillKnowledgeRepository } from './course-skill-knowledge';
import { courseSkillDraftDependencies } from './course-skill-drafts';
import { generateCourseSkillDrafts } from '../features/course-skills/draft-service';
import type { SkillBuildLease } from '../persistence/contracts/course-skill-knowledge-repository';
import { supportedSkillFacts, type SkillTask } from '../domain/learning/course-skill-draft';
import type { SkillKnowledgeChunk } from '../domain/learning/skill-knowledge';
import type { generateCourseSkillJson } from './course-skill-model';

export async function createCourseSkillCandidateRepository(env: Bindings) {
  if (persistenceBackend(env) === 'd1') {
    if (!env.DB) throw new Error('D1 DB binding is required');
    const { createD1SkillSqlDriver } = await import('../persistence/d1/course-skill-input-repository');
    return createSqlCourseSkillCandidateRepository(createD1SkillSqlDriver(env.DB));
  }
  const { createPostgresSkillSqlDriver } = await import('../persistence/postgres/course-skill-input-repository');
  return createSqlCourseSkillCandidateRepository(createPostgresSkillSqlDriver(env));
}

/** Only server-issued cache keys are accepted; knowledge reads revalidate the build lease. */
export async function generateAndSaveCourseSkillCandidates(env: Bindings, input: {
  lease: SkillBuildLease; courseId: number; language: 'ja' | 'en'; generationEpoch: number; knowledgeKeys: string[];
}, generate?: typeof generateCourseSkillJson) {
  const knowledge = await createCourseSkillKnowledgeRepository(env);
  const repository = await createCourseSkillCandidateRepository(env);
  const chunks: SkillKnowledgeChunk[] = [];
  for (const key of new Set(input.knowledgeKeys)) {
    const chunk = await knowledge.cached(input.lease, key, Date.now());
    if (!chunk) throw new Error('SKILL_INPUT_CHANGED');
    chunks.push(chunk);
  }
  const previous = await repository.list(input.courseId, input.lease.ownerId);
  const existing = new Map<string, SkillTask>();
  for (const candidate of previous) existing.set(candidate.skillId, candidate.content.task);
  const dependencies = courseSkillDraftDependencies(env, input.lease.ownerId, input.language, generate);
  let taskIndex = 0;
  dependencies.id = () => { let id: string; do { id = `${input.lease.id}-${taskIndex++}`; } while (existing.has(id)); return id; };
  const latest = new Map(previous.map(candidate => [candidate.skillId, candidate]));
  const force = [...latest.values()].some(c => (c.content.generation?.epoch ?? 0) < input.generationEpoch);
  const result = await generateCourseSkillDrafts(dependencies, chunks, [...existing.values()], { force });
  const candidates = [...result.candidates];
  const reboundIds = new Set<string>();
  const generatedIds = new Set(candidates.map(c => c.task.skillId));
  const currentFacts = new Map(supportedSkillFacts(chunks).map(f => [f.id, JSON.stringify(f)]));
  // Unchanged, unpublished review work must remain reviewable after an unrelated
  // source change. Rebind only byte-identical current evidence, retaining edits
  // and review issues; published/rejected candidates are not revived.
  for (const previous of latest.values()) {
    if (generatedIds.has(previous.skillId) || !['review_required', 'approved'].includes(previous.status)) continue;
    if (previous.content.facts.some(f => currentFacts.get(f.id) !== JSON.stringify(f))) continue;
    candidates.push(previous.content);
    reboundIds.add(previous.skillId);
  }
  for (const candidate of candidates) {
    const content = { ...candidate, issues: [...result.issues, ...candidate.issues], generation: reboundIds.has(candidate.task.skillId) ? latest.get(candidate.task.skillId)?.content.generation : {
      knowledgeModels: [...new Set(chunks.map(c => c.model))], knowledgePromptVersions: [...new Set(chunks.map(c => c.promptVersion))], draftPromptVersion: 'course-draft-v4-bounded-repair', language: input.language, epoch: input.generationEpoch,
    } };
    const contentHash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(content))))].map(n => n.toString(16).padStart(2, '0')).join('');
    if (!await repository.save(input.lease, { id: crypto.randomUUID(), content, contentHash }, Date.now())) throw new Error('SKILL_INPUT_CHANGED');
  }
  return { candidates: candidates.length, heldVisualFacts: result.heldVisualFacts, issues: result.issues };
}
