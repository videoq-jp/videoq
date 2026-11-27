import { createHash } from 'node:crypto';
import { createCourseSkillPublicationRepository } from '../../src/integrations/course-skill-publications';
import type { Bindings } from '../../src/types/bindings';

/** Pins actual accessible publication revisions, not just a local approval flag. */
export async function publicationVersionHashes(env: Bindings, ownerId: string, courseId: number) {
  const repository = await createCourseSkillPublicationRepository(env);
  const hashes: string[] = [];
  let after = '';
  for (let page = 0; page < 10; page++) {
    const publications = await repository.list(ownerId, 21, after);
    for (const publication of publications.slice(0, 20).filter(p => p.courseId === courseId)) {
      const value = { id: publication.id, courseId: publication.courseId, skillId: publication.skillId, name: publication.name, description: publication.description,
        files: [...publication.manifest].sort((a, b) => a.path.localeCompare(b.path)).map(f => ({ path: f.path, digest: f.digest, size: f.size })) };
      hashes.push(createHash('sha256').update(JSON.stringify(value)).digest('hex'));
    }
    if (publications.length <= 20) return hashes.sort();
    after = publications[19].id;
  }
  throw new Error('COHORT_PUBLICATION_SCOPE_TOO_LARGE');
}
export async function assertPublicationVersions(env: Bindings, ownerId: string, courseId: number, expected: readonly string[]) {
  const actual = await publicationVersionHashes(env, ownerId, courseId);
  if (!actual.length || JSON.stringify(actual) !== JSON.stringify([...expected].sort())) throw new Error('COHORT_PUBLICATION_CHANGED_OR_UNAVAILABLE');
}
