import type { SkillDraft } from '@videoq/domain/agent-skills';
import type { SkillTask, SupportedSkillFact } from '../../domain/learning/course-skill-draft';
import type { SkillBuildLease } from './course-skill-knowledge-repository';
export type CourseSkillCandidateContent = { task: SkillTask; draft: SkillDraft | null; facts: SupportedSkillFact[]; issues: string[] };
export type CourseSkillCandidate = {
  id: string; courseId: number; buildId: string; skillId: string; content: CourseSkillCandidateContent;
  contentHash: string; status: string; approvedHash: string | null;
};
export interface CourseSkillCandidateRepository {
  save(lease: SkillBuildLease, candidate: { id: string; content: CourseSkillCandidateContent; contentHash: string }, now: number): Promise<boolean>;
  list(courseId: number, ownerId: string): Promise<CourseSkillCandidate[]>;
  edit(id: string, ownerId: string, expectedHash: string, content: CourseSkillCandidateContent, newHash: string): Promise<boolean>;
}
