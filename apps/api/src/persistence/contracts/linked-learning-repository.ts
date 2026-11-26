import type { LinkedLearningCourse } from '../../domain/lms/linked-course';
export type { LinkedLearningCourse } from '../../domain/lms/linked-course';
/** Resolve a current teacher-owned course and its playable members. */
export interface LinkedLearningRepository {
  findCourse(installationId:string,contextId:string):Promise<LinkedLearningCourse|null>;
}
