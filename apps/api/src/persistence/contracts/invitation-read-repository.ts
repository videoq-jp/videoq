import type {InvitationStatus,InvitationDeliveryStatus} from '../../lib/course-invitations';
export type CourseInvitationListItem = {
  id: number;
  email: string;
  status: InvitationStatus;
  delivery_status: InvitationDeliveryStatus;
  expires_at: string;
  created_at: string;
  last_sent_at: string | null;
  send_attempts: number;
};

export type CourseUserMemberListItem = {
  user_id: string;
  username: string;
  email: string;
  joined_at: string;
};

export type InvitationPreviewRecord = {
  course_id: number;
  course_name: string;
  inviter_name: string;
  email: string;
  status: InvitationStatus;
  expires_at: string;
};

export interface InvitationReadRepository {
 participants(courseId:number,ownerId:string):Promise<{notFound:true}|{invitations:CourseInvitationListItem[];members:CourseUserMemberListItem[]}>;
 preview(tokenHash:string):Promise<InvitationPreviewRecord|null>;
}
