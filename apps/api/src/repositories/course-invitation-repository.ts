import {createInvitationCreateRepository,createInvitationWriteRepository,createInvitationDeliveryRepository,createInvitationReadRepository} from '../persistence/factory';
import type {Bindings} from '../types/bindings';
import type {ExternalTaskLease} from '../persistence/contracts/external-task-repository';
import type {PendingInvitationInput} from '../persistence/contracts/invitation-create-repository';
export type {PendingInvitationInput} from '../persistence/contracts/invitation-create-repository';
export async function createPendingCourseInvitations(env:Bindings,course:number,owner:string,inputs:readonly PendingInvitationInput[]){return (await createInvitationCreateRepository(env)).create(course,owner,inputs);}

export type {InvitationDeliveryOutcome} from '../persistence/contracts/invitation-delivery-repository';
export async function recordInvitationDeliveryOutcomes(env:Bindings,outcomes:readonly import('../persistence/contracts/invitation-delivery-repository').InvitationDeliveryOutcome[],opts:{lease:ExternalTaskLease;completeTask?:boolean}):Promise<void>{
 return (await createInvitationDeliveryRepository(env)).record(outcomes,opts);
}
export async function failInvitationsWithoutLiveDelivery(env:Bindings,now:Date,graceMs:number){
 return (await createInvitationDeliveryRepository(env)).failStranded(now,graceMs);
}
export async function rotateInvitationTokenForDelivery(env:Bindings,id:number,tokenHash:string,now:Date,lease:ExternalTaskLease){
 return (await createInvitationDeliveryRepository(env)).rotate(id,tokenHash,now,lease);
}

export type {CourseInvitationListItem,CourseUserMemberListItem,InvitationPreviewRecord} from '../persistence/contracts/invitation-read-repository';
export async function listCourseParticipants(env:Bindings,courseId:number,ownerId:string){return (await createInvitationReadRepository(env)).participants(courseId,ownerId);}
export async function getCourseInvitationByTokenHash(env:Bindings,hash:string){return (await createInvitationReadRepository(env)).preview(hash);}

export async function acceptCourseInvitation(env:Bindings,hash:string,user:string,now:Date){return (await createInvitationWriteRepository(env)).decide('accept',hash,user,now);}
export async function declineCourseInvitation(env:Bindings,hash:string,user:string,now:Date){return (await createInvitationWriteRepository(env)).decide('decline',hash,user,now);}
export async function rotatePendingCourseInvitation(env:Bindings,course:number,id:number,owner:string,hash:string,expiresAt:Date,now:Date){return (await createInvitationWriteRepository(env)).control('resend',course,id,owner,now,{tokenHash:hash,expiresAt});}
export async function revokePendingCourseInvitation(env:Bindings,course:number,id:number,owner:string,now:Date){return (await createInvitationWriteRepository(env)).control('revoke',course,id,owner,now);}
export async function removeCourseUserMember(env:Bindings,course:number,member:string,owner:string){return (await createInvitationWriteRepository(env)).remove(course,member,owner);}
export async function leaveCourseMembership(env:Bindings,course:number,user:string){return (await createInvitationWriteRepository(env)).leave(course,user);}
