import { boundCourseAccess, linkedCourseBinding, linkedBindingRequested } from '../../domain/lms/course-binding';
import { type CourseAccess, type CourseAccessRegistration, type CourseAuthorityResponse, type CourseGrant } from '../../domain/lms/lms-authority';
import type { LinkedLearningCourse } from '../../persistence/contracts/linked-learning-repository';

export interface CourseAccessDependencies {
  requestAuthority(grant: CourseGrant): Promise<CourseAuthorityResponse | null>;
  findLinkedCourse?: (installationId: string, contextId: string) => Promise<LinkedLearningCourse | null>;
}

/** Trusted administrator-configured origin only. Never follow redirects or cache permissions. */
export async function resolveCourseAccess(reg: CourseAccessRegistration, grant: CourseGrant, deps: CourseAccessDependencies): Promise<CourseAccess | null> {
  const access = await deps.requestAuthority(grant);
  const linked = linkedBindingRequested(reg, grant);
  if (linked) {
    if (!deps.findLinkedCourse || !access?.courseEntry || !reg.id.startsWith('db:')) throw new Error('LMS access denied');
    const connection = await deps.findLinkedCourse(reg.id.slice(3), grant.contextId);
    return linkedCourseBinding(grant, access, connection);

  }
  return access ? boundCourseAccess(reg, grant, access) : null;
}
