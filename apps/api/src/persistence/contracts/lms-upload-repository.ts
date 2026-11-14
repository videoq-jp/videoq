import type {OwnedLmsGrant} from './lms-resource-repository';
import type {OutboxedVideoJob} from './video-upload-repository';
export type LmsUploadSnapshot={resourceId:string;externalId:string;generation:number;videoId:number;fileKey:string;size:number;contentType:string};
export type LmsContentAttempt={id:string;grant:OwnedLmsGrant;snapshot:LmsUploadSnapshot;fileKey:string};
export type LmsUploadConfirmation={status:'stale'}|{status:'already'}|{status:'queued';job:OutboxedVideoJob};
export interface LmsUploadRepository{
 prepare(attempt:LmsContentAttempt):Promise<boolean>;
 adopt(attempt:LmsContentAttempt):Promise<boolean>;
 abandon(attempt:LmsContentAttempt):Promise<void>;
 confirm(grant:OwnedLmsGrant,snapshot:LmsUploadSnapshot,objectVerified:boolean):Promise<LmsUploadConfirmation>;
}
