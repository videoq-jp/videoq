export type PendingInvitationInput = {
  email: string;
  tokenHash: string;
  expiresAt: Date;
  createdAt: Date;
};

export type CreatedInvitations={notFound:true}|{created:{id:number;email:string}[];alreadyMemberEmails:string[];alreadyPendingEmails:string[]};
export interface InvitationCreateRepository {create(courseId:number,ownerId:string,inputs:readonly PendingInvitationInput[]):Promise<CreatedInvitations>}
export function validateInvitationBatch(inputs:readonly PendingInvitationInput[]):void {
 if(inputs.length>100)throw new Error('At most 100 invitation recipients are allowed');
 for(const input of inputs){input.createdAt.toISOString();input.expiresAt.toISOString();}
}
