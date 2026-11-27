import type { SkillKnowledgeChunk } from '../../domain/learning/skill-knowledge';
// Leaves room for ownership/lease bindings under D1's 100-parameter limit.
export const COURSE_SKILL_KNOWLEDGE_READ_BATCH_SIZE = 80;
export type SkillBuildLease = { id: string; ownerId: string; token: string; generation: number };
export interface CourseSkillKnowledgeRepository {
  readPage(lease: SkillBuildLease, videoId: number, offset: number, now: number): Promise<{ text: string; nextOffset: number; done: boolean } | null>;
  visualSource?(lease: SkillBuildLease, videoId: number, now: number): Promise<{ id: number; fileKey: string; visualRunId?: string | null; visualManifestVersion?: string | null; expectedRunId?: string } | null>;
  cached(lease: SkillBuildLease, key: string, now: number): Promise<SkillKnowledgeChunk | null>;
  cachedMany?(lease: SkillBuildLease, keys: readonly string[], now: number): Promise<Map<string, SkillKnowledgeChunk>>;
  save(lease: SkillBuildLease, key: string, chunk: SkillKnowledgeChunk, now: number): Promise<boolean>;
}
