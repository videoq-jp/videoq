import { resolveCourseAccess } from '../features/lti/course-access-service';
import { requestCourseAuthority } from '../features/lms/authority';
import { linkedLearningCourse } from '../repositories/linked-learning-repository';
import type { Bindings } from '../types/bindings';
import type { LtiRegistration } from '../features/lti/config';
import type { CourseGrant } from '../domain/lms/lms-authority';
export type { CourseAccess, CourseVideo } from '../domain/lms/lms-authority';

/** Fresh authority I/O and persistence are composed outside the access policy. */
export function courseAccessContext(reg: LtiRegistration, grant: CourseGrant, env?: Bindings) {
  return resolveCourseAccess(reg, grant, {
    requestAuthority: current => requestCourseAuthority(reg, current, env),
    ...(env ? { findLinkedCourse: (installationId: string, contextId: string) => linkedLearningCourse(env, installationId, contextId) } : {}),
  });
}
export async function courseAccess(reg: LtiRegistration, grant: CourseGrant, env?: Bindings) {
  return (await courseAccessContext(reg, grant, env))?.videos ?? null;
}
