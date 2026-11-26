import type { OwnedLmsGrant, LmsUploadSnapshot, LmsContentAttempt } from '../../domain/lms/lms-upload';
export type { LmsUploadSnapshot, LmsContentAttempt } from '../../domain/lms/lms-upload';
import type {OutboxedVideoJob} from './video-upload-repository';
export type LmsUploadConfirmation={status:'stale'}|{status:'already'}|{status:'queued';job:OutboxedVideoJob};
export interface LmsUploadRepository{
 prepare(attempt:LmsContentAttempt):Promise<boolean>;
 adopt(attempt:LmsContentAttempt):Promise<boolean>;
 abandon(attempt:LmsContentAttempt):Promise<void>;
 confirm(grant:OwnedLmsGrant,snapshot:LmsUploadSnapshot,objectVerified:boolean):Promise<LmsUploadConfirmation>;
}
