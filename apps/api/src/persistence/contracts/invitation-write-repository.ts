import type {InvitationStatus} from "../../lib/course-invitations";
export type InvitationDecisionResult =
  | { notFound: true }
  | { emailUnverified: true }
  | { emailMismatch: true }
  | { invalidState: InvitationStatus }
  | { expired: true }
  | { ok: true; courseId: number };

export type InvitationControlResult={notFound:true}|{invalidState:InvitationStatus}|{ok:true};
export type MembershipRemovalResult={notFound:true}|{ok:true};
export interface InvitationWriteRepository {
 decide(action:'accept'|'decline',hash:string,userId:string,now:Date):Promise<InvitationDecisionResult>;
 control(action:'resend'|'revoke',courseId:number,invitationId:number,ownerId:string,now:Date,replacement?:{tokenHash:string;expiresAt:Date}):Promise<InvitationControlResult>;
 remove(courseId:number,memberId:string,ownerId:string):Promise<MembershipRemovalResult>;
 leave(courseId:number,userId:string):Promise<MembershipRemovalResult>;
}
