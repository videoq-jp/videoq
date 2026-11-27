export type SkillPublicationFile = { path: string; content: string; digest: string; size: number };
export type CourseSkillPublication = {
  id: string; courseId: number; skillId: string; name: string; description: string; manifest: Omit<SkillPublicationFile, 'content'>[];
};
export interface CourseSkillPublicationRepository {
  approve(candidateId: string, ownerId: string, expectedHash: string): Promise<boolean>;
  stage(ownerId: string, input: { id: string; candidateId: string; expectedHash: string; name: string; description: string; sources: string; files: SkillPublicationFile[] }): Promise<boolean>;
  publish(id: string, ownerId: string, expectedHash: string): Promise<boolean>;
  list(userId: string, limit: number, after: string): Promise<CourseSkillPublication[]>;
  get(id: string, userId: string): Promise<CourseSkillPublication | null>;
  read(id: string, path: string, userId: string): Promise<SkillPublicationFile | null>;
  withdraw(courseId: number, skillId: string, ownerId: string): Promise<boolean>;
}
