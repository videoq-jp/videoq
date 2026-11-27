import type { Bindings } from '../types/bindings';
import { persistenceBackend } from '../persistence/backend';
import { createSqlCourseSkillPublicationRepository } from '../persistence/course-skill-publication-sql';
import { createCourseSkillCandidateRepository } from './course-skill-candidates';
import { renderCourseSkill } from '../domain/learning/course-skill-draft';
import { createCourseSkillInputRepository } from './course-skill-inputs';

const digest = async (value: string) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))].map(n => n.toString(16).padStart(2, '0')).join('');
export async function createCourseSkillPublicationRepository(env: Bindings) {
  if (persistenceBackend(env) === 'd1') {
    if (!env.DB) throw new Error('D1 DB binding is required');
    const { createD1SkillSqlDriver } = await import('../persistence/d1/course-skill-input-repository');
    return createSqlCourseSkillPublicationRepository(createD1SkillSqlDriver(env.DB));
  }
  const { createPostgresSkillSqlDriver } = await import('../persistence/postgres/course-skill-input-repository');
  return createSqlCourseSkillPublicationRepository(createPostgresSkillSqlDriver(env));
}

/** Called only by an explicit owner review action with the exact reviewed hash. */
export async function publishCourseSkillCandidate(env: Bindings, input: { courseId: number; candidateId: string; ownerId: string; expectedHash: string }) {
  const candidates = await createCourseSkillCandidateRepository(env);
  const candidate = (await candidates.list(input.courseId, input.ownerId)).find(c => c.id === input.candidateId);
  if (!candidate || candidate.contentHash !== input.expectedHash || !candidate.content.draft || candidate.content.issues.length) throw new Error('SKILL_CANDIDATE_NOT_READY');
  const repository = await createCourseSkillPublicationRepository(env);
  const rendered = renderCourseSkill(input.courseId, candidate.content.draft, candidate.content.facts);
  const id = `${candidate.id}-${candidate.contentHash}`;
  const already = await repository.get(id, input.ownerId);
  if (already) return { revisionId: id };
  if (!await repository.approve(candidate.id, input.ownerId, input.expectedHash)) throw new Error('SKILL_CANDIDATE_CHANGED');
  const snapshot = await (await createCourseSkillInputRepository(env)).snapshot(input.courseId, input.ownerId);
  if (!snapshot) throw new Error('SKILL_INPUT_CHANGED');
  const videoIds = new Set(candidate.content.facts.map(f => f.videoId));
  const sources = (JSON.parse(snapshot.sourceState) as unknown[][]).filter(row => videoIds.has(Number(row[1])));
  const files = [];
  for (const file of rendered.files) files.push({ ...file, size: new TextEncoder().encode(file.content).byteLength, digest: `sha256:${await digest(file.content)}` });
  if (!await repository.stage(input.ownerId, { id, candidateId: candidate.id, expectedHash: input.expectedHash, name: rendered.name, description: rendered.description, sources: JSON.stringify(sources), files })) throw new Error('SKILL_INPUT_CHANGED');
  if (!await repository.publish(id, input.ownerId, input.expectedHash)) throw new Error('SKILL_INPUT_CHANGED');
  return { revisionId: id };
}
