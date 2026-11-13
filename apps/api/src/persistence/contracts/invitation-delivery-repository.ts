import type {InvitationDeliveryStatus,InvitationStatus} from '../../lib/course-invitations';
import type {ExternalTaskLease} from './external-task-repository';
export type InvitationDeliveryOutcome = {
  invitationId: number;
  status: Exclude<InvitationDeliveryStatus, "queued">;
  attemptedAt: Date;
  error?: string;
};

export type InvitationTokenRotation = {notFound:true}|{invalidState:InvitationStatus}|{email:string;courseName:string;inviterName:string};
export interface InvitationDeliveryRepository {
 record(outcomes:readonly InvitationDeliveryOutcome[],opts:{lease:ExternalTaskLease;completeTask?:boolean}):Promise<void>;
 failStranded(now:Date,graceMs:number):Promise<{failed:number}>;
 rotate(invitationId:number,tokenHash:string,now:Date,lease:ExternalTaskLease):Promise<InvitationTokenRotation>;
}
