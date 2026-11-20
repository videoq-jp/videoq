import type { LearningGrant, LearningCourse } from './native-learning';
import type { LtiRegistration } from './lti-registration';
import type { CourseAccess } from './lms-authority';

export type LearningAuthorization = {
  grant: LearningGrant; reg: LtiRegistration; sessionHash: string;
  current?: CourseAccess; course?: LearningCourse;
};

export function registrationFingerprintInput(reg: LtiRegistration): string {
  return JSON.stringify(reg.id.startsWith('db:') ? { ...reg, resources: [] } : reg);
}

export function learningFeatures(reg: LtiRegistration, grant?: Pick<LearningGrant, 'courseId' | 'contextId' | 'resourceLinkId'>) {
  const courseAccess = Boolean(reg.courseAccess || reg.materialsService || reg.id.startsWith('classroom:'));
  const linked = grant && reg.resources.some(item => item.kind === 'linked' && item.courseId === grant.courseId
    && item.contextId === grant.contextId && item.resourceLinkId === grant.resourceLinkId);
  const managed = reg.id.startsWith('db:') && !linked;
  return { transcripts: courseAccess, qa: courseAccess, conversations: courseAccess,
    management: managed, tags: managed, reports: managed };
}
