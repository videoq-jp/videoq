import type { LtiRegistration } from './lti-registration';
import type { LearningGrant } from './native-learning';
import { deniedCoursePermissions, type CourseAccess } from './lms-authority';

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

export type LearningCapabilityAccess = { current: CourseAccess; reg: Pick<LtiRegistration, 'id'> };
export const canUseLearningConversations = (access: LearningCapabilityAccess) => access.current.permissions.manageOwnHistory;
export const canUseLearningTags = (access: LearningCapabilityAccess) => access.reg.id.startsWith('db:');
export const canChangeLearningTags = (access: LearningCapabilityAccess, action: string) => action === 'list' || access.current.permissions.manageContent;
export const canManageLearningMaterials = (access: LearningCapabilityAccess) => access.reg.id.startsWith('db:') && access.current.permissions.manageContent;
export const canReadLearningReports = (access: LearningCapabilityAccess) => access.current.permissions.viewReports && access.reg.id.startsWith('db:');


export function classroomLearningPermissions(teacher: boolean) {
  return { ...deniedCoursePermissions, manageOwnHistory: true, viewTranscript: true,
    viewQa: true, postQa: true, voteQa: true, deleteOwnQa: true, moderateQa: teacher, instructorQa: teacher };
}
export function classroomOwnerHistory(teacher: boolean, connectionTeacher: string | undefined, subject: string): boolean {
  return teacher && connectionTeacher === subject;
}
