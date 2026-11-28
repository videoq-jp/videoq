import type { SkillBuildLease } from './course-skill-knowledge-repository';
export interface CourseSkillExecutionRepository {
  pending(now: number): Promise<{ id: string; ownerId: string } | null>;
  nextWakeup(): Promise<number | null>;
  current(lease: SkillBuildLease, now: number): Promise<boolean>;
  release(lease: SkillBuildLease, checkpoint: string, state: 'queued' | 'failed', now: number, delayMs: number): Promise<boolean>;
  readStep(lease: SkillBuildLease, key: string, now: number): Promise<string | null>;
  saveStep(lease: SkillBuildLease, key: string, content: string, now: number): Promise<boolean>;
  progress(courseId: number, ownerId: string): Promise<{ id: string; revision: number; state: string; checkpoint: string }[]>;
}
