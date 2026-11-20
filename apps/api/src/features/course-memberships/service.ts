/** Compatibility entrypoint; workflows are composed outside the application. */
export { inviteCourseMembers, previewCourseInvitation, acceptInvitation, declineInvitation,
  resendInvitation, revokeInvitation, getCourseParticipants, removeMember, leaveCourse,
} from '../../integrations/course-memberships';
export type { InviteRecipientResult } from './core';
