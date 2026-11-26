import type { LtiSessionProof } from './lti-session-proof';
export type { CourseTagCommand } from '../domain/learning/course-tags';
import type { CourseTagAccess } from '../domain/learning/course-tags';
export type CourseTagScope = CourseTagAccess & {
  installationId: string; contextId: string; courseId: number; ownerUserId: string; actorKey: string;
  sessionProof?: LtiSessionProof;
};
export type { CourseTag, CourseTagCatalog } from '../domain/learning/course-tags';
export { MAX_COURSE_TAGS } from '../domain/learning/course-tags';
