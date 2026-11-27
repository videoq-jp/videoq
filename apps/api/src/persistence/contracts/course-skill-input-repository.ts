export type CourseSkillSettings = {
  generationEnabled: boolean;
  distributionEnabled: boolean;
  policyVersion: string;
  language: 'ja' | 'en';
};
export type CourseSkillSource = {
  membershipId: number; videoId: number; title: string; status: string;
  analysisRevision: string; visualRevision: string; ready: boolean;
};
export type CourseSkillSnapshot = {
  courseId: number; ownerId: string; revision: number; sourceState: string;
  settings: CourseSkillSettings; sources: CourseSkillSource[];
};
export type CourseSkillBuild = {
  id: string; courseId: number; revision: number; inputKey: string; input: string;
  state: string; leaseToken: string | null; leaseUntil: number; generation: number; checkpoint: string;
};
export interface CourseSkillInputRepository {
  configure(courseId: number, ownerId: string, settings: CourseSkillSettings): Promise<boolean>;
  /** Authoritative source state and settings read in one database snapshot. */
  snapshot(courseId: number, ownerId: string): Promise<CourseSkillSnapshot | null>;
  due(now: number, limit: number): Promise<{ courseId: number; ownerId: string }[]>;
  affected(videoId: number): Promise<{ courseId: number; ownerId: string }[]>;
  /** CAS includes the live source projection, not just the reconciliation cursor. */
  reconcile(snapshot: CourseSkillSnapshot, build: { id: string; inputKey: string; input: string } | null, now: number): Promise<boolean>;
  claim(id: string, ownerId: string, token: string, now: number, leaseMs: number): Promise<CourseSkillBuild | null>;
  checkpoint(id: string, ownerId: string, token: string, generation: number, value: string, now: number): Promise<boolean>;
  complete(id: string, ownerId: string, token: string, generation: number, now: number): Promise<boolean>;
}
