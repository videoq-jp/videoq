import * as workflow from '../features/course-memberships/core';
import type { CourseMembershipDependencies } from '../features/course-memberships/ports';
import * as repository from '../repositories/course-invitation-repository';
import { features } from '../lib/deployment';
import { authBaseURL } from '../lib/auth';
import { createInvitationToken, hashInvitationToken, resolveInvitationBatchLimit } from '../lib/course-invitations';
import type { Bindings } from '../types/bindings';

function dependencies(env: Bindings): CourseMembershipDependencies {
  return {
    now: () => new Date(),
    createRepository: { create: (...args) => repository.createPendingCourseInvitations(env, ...args) },
    readRepository: {
      participants: (...args) => repository.listCourseParticipants(env, ...args),
      preview: hash => repository.getCourseInvitationByTokenHash(env, hash),
    },
    writeRepository: {
      decide: (action, hash, user, now) => action === 'accept'
        ? repository.acceptCourseInvitation(env, hash, user, now)
        : repository.declineCourseInvitation(env, hash, user, now),
      control: (action, course, id, owner, now, replacement) => {
        if (action === 'revoke') return repository.revokePendingCourseInvitation(env, course, id, owner, now);
        if (!replacement) throw new Error('Resend requires a replacement token');
        return repository.rotatePendingCourseInvitation(env, course, id, owner, replacement.tokenHash, replacement.expiresAt, now);
      },
      remove: (...args) => repository.removeCourseUserMember(env, ...args),
      leave: (...args) => repository.leaveCourseMembership(env, ...args),
    },
    createToken: createInvitationToken,
    hashToken: hashInvitationToken,
    batchLimit: resolveInvitationBatchLimit(env.COURSE_INVITATION_BATCH_LIMIT),
    emailDelivery: features(env).emailDelivery,
    baseUrl: authBaseURL(env),
  };
}

type WorkflowArgs<F> = F extends (deps: CourseMembershipDependencies, ...args: infer A) => unknown ? A : never;
export function inviteCourseMembers(env: Bindings, ...args: WorkflowArgs<typeof workflow.inviteCourseMembers>) {
  return workflow.inviteCourseMembers(dependencies(env), ...args);
}
export function previewCourseInvitation(env: Bindings, ...args: WorkflowArgs<typeof workflow.previewCourseInvitation>) {
  return workflow.previewCourseInvitation(dependencies(env), ...args);
}
export function acceptInvitation(env: Bindings, ...args: WorkflowArgs<typeof workflow.acceptInvitation>) {
  return workflow.acceptInvitation(dependencies(env), ...args);
}
export function declineInvitation(env: Bindings, ...args: WorkflowArgs<typeof workflow.declineInvitation>) {
  return workflow.declineInvitation(dependencies(env), ...args);
}
export function resendInvitation(env: Bindings, ...args: WorkflowArgs<typeof workflow.resendInvitation>) {
  return workflow.resendInvitation(dependencies(env), ...args);
}
export function revokeInvitation(env: Bindings, ...args: WorkflowArgs<typeof workflow.revokeInvitation>) {
  return workflow.revokeInvitation(dependencies(env), ...args);
}
export {
  listCourseParticipants as getCourseParticipants,
  removeCourseUserMember as removeMember,
  leaveCourseMembership as leaveCourse,
} from '../repositories/course-invitation-repository';
