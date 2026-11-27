import type { LearningGrant, LearningCourse } from '../domain/lms/native-learning';
import type { LtiRegistration } from '../domain/lms/lti-registration';
import type { CourseAccess } from '../domain/lms/lms-authority';

export type LearningAuthorization = {
  grant: LearningGrant; reg: LtiRegistration; sessionHash: string;
  current?: CourseAccess; course?: LearningCourse;
};
