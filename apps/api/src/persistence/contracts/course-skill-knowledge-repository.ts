import type { SkillKnowledgeChunk } from '../../domain/learning/skill-knowledge';
export type SkillBuildLease = { id: string; ownerId: string; token: string; generation: number };
export interface CourseSkillKnowledgeRepository {
  readPage(lease: SkillBuildLease, videoId: number, offset: number, now: number): Promise<{ text: string; nextOffset: number; done: boolean } | null>;
  visualSource?(lease: SkillBuildLease, videoId: number, now: number): Promise<{ id: number; fileKey: string; visualRunId?: string | null; visualManifestVersion?: string | null } | null>;
  cached(lease: SkillBuildLease, key: string, now: number): Promise<SkillKnowledgeChunk | null>;
  save(lease: SkillBuildLease, key: string, chunk: SkillKnowledgeChunk, now: number): Promise<boolean>;
}
