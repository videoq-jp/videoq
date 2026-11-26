import { qaOperationPrecheck } from '../../domain/qa/policy';
import { courseQaAuthorInput } from '../../application/subject-identity';
import type { LtiQaPrincipal } from '../../persistence/contracts/qa-repository';
import type { CourseAccess } from '../../domain/lms/lms-authority';
import type { LearningGrant, LearningCourse } from '../../domain/lms/native-learning';
import type { LtiRegistration } from '../../domain/lms/lti-registration';
import type { LtiSessionProof } from '../../application/lti-session-proof';
import type { ConversationScope } from '../../persistence/contracts/conversation-read';
import type { CourseReportScope } from '../../persistence/contracts/course-report-repository';
import type { CourseTagScope } from '../../persistence/contracts/course-tag-repository';
import type { ManagedMaterialScope } from '../../persistence/contracts/material-management-repository';

export type LearningOperationAccess = {
  current: CourseAccess; reg: LtiRegistration; grant: LearningGrant; sessionHash: string;
  course: Pick<LearningCourse, 'userId' | 'memberVideoIds'>;
};
export { canUseLearningConversations, canUseLearningTags, canChangeLearningTags, canManageLearningMaterials, canReadLearningReports } from '../../domain/lms/learning-features';

export function learningConversationScope(access: LearningOperationAccess, subjectKey: string, sessionProof: LtiSessionProof): ConversationScope {
  const { course, grant, current } = access;
  return { ownerUserId: course.userId, actorUserId: null, courseId: grant.courseId, shareSlug: null,
    ltiSubject: { subjectKey, sessionProof,
      resourceVideoIds: current.videos.map(video => video.videoId).filter(id => course.memberVideoIds.includes(id)) } };
}
export async function learningConversationTurns<Turn extends { chatLogId: number | null; feedbackToken?: string }>(
  turns: Turn[], action: 'get' | 'export', reference: (logId: number | null) => Promise<string | undefined>,
) {
  return Promise.all(turns.map(async ({ chatLogId, feedbackToken: _feedbackToken, ...turn }) => ({ ...turn,
    ...(action === 'get' ? { feedbackId: await reference(chatLogId) } : {}),
  })));
}

export function learningReportScope(access: LearningOperationAccess, sessionProof: LtiSessionProof): CourseReportScope {
  const { reg, grant, course, current } = access;
  return { installationId: reg.id.slice(3), contextId: grant.contextId, courseId: grant.courseId, ownerUserId: course.userId,
    sessionProof, readable: current.videos.flatMap(video => {
      const binding = reg.resources.find(item => item.videoId === video.videoId && item.courseId === grant.courseId
        && item.contextId === grant.contextId && item.deploymentId === grant.deploymentId);
      return binding?.generation && course.memberVideoIds.includes(video.videoId)
        ? [{ videoId: video.videoId, generation: binding.generation, resourceLinkId: binding.resourceLinkId }] : [];
    }) };
}
export function learningTagScope(access: LearningOperationAccess, actorKey: string, sessionProof: LtiSessionProof): CourseTagScope {
  const { reg, grant, course, current } = access;
  return { installationId: reg.id.slice(3), contextId: grant.contextId, courseId: grant.courseId, ownerUserId: course.userId,
    sessionProof, actorKey, manage: current.permissions.manageContent,
    readableVideoIds: current.videos.map(video => video.videoId).filter(id => course.memberVideoIds.includes(id)),
    management: (current.managementVideos ?? []).flatMap(video => {
      const binding = reg.resources.find(item => item.videoId === video.videoId && item.courseId === grant.courseId
        && item.contextId === grant.contextId && item.deploymentId === grant.deploymentId);
      return current.permissions.manageContent && video.management && binding && course.memberVideoIds.includes(video.videoId)
        ? [{ videoId: video.videoId, resourceLinkId: binding.resourceLinkId, generation: video.management.generation }] : [];
    }) };
}
export function learningManagedMaterialScope(access: LearningOperationAccess, videoId: number): Omit<ManagedMaterialScope, 'actorKey' | 'sessionProof'> | null {
  const { current, reg, grant, course } = access;
  const material = current.managementVideos?.find(item => item.videoId === videoId);
  const binding = reg.resources.find(item => item.videoId === videoId && item.courseId === grant.courseId
    && item.contextId === grant.contextId && item.deploymentId === grant.deploymentId);
  if (!material?.management || !binding || !course.memberVideoIds.includes(videoId)) return null;
  return { installationId: reg.id.slice(3), ownerUserId: course.userId, courseId: grant.courseId, contextId: grant.contextId,
    resourceLinkId: binding.resourceLinkId, videoId, generation: material.management.generation };
}


export type LearningQaAccess = Omit<LearningOperationAccess, 'reg'>;
export function canUseLearningQa(access: LearningQaAccess, action: string): boolean {
  const permissions = access.current.permissions;
  return qaOperationPrecheck(action, { view: permissions.viewQa, canPost: permissions.postQa,
    canVote: permissions.voteQa, canDeleteOwn: permissions.deleteOwnQa, canModerate: permissions.moderateQa });
}
export const learningQaAuthorIdentity = (grant: LearningGrant) => courseQaAuthorInput(grant);
export function learningQaPrincipal(access: LearningQaAccess, authorId: string, sessionProof: LtiSessionProof): LtiQaPrincipal {
  const { grant, course, current } = access, permissions = current.permissions;
  return { kind: 'lti', courseId: grant.courseId, ownerUserId: course.userId, sessionProof, authorId,
    videoIds: current.videos.map(video => video.videoId).filter(id => course.memberVideoIds.includes(id)),
    permissions: { view: permissions.viewQa, post: permissions.postQa, vote: permissions.voteQa,
      deleteOwn: permissions.deleteOwnQa, moderate: permissions.moderateQa, instructor: permissions.instructorQa } };
}
