import type {LmsContentAttempt,LmsUploadSnapshot} from '../persistence/contracts/lms-upload-repository';
import {parseReservedBytesFromFileKey} from '../lib/upload';
export const contentSlot=(s:LmsUploadSnapshot)=>'lms-content-upload:'+s.videoId;
export const contentCleanup=(id:string)=>'lms-content-stage:'+id;
export const contentPayload=(a:LmsContentAttempt)=>JSON.stringify({id:a.id,installationId:a.grant.id,ownerUserId:a.grant.ownerUserId,
 snapshot:[a.snapshot.resourceId,a.snapshot.externalId,a.snapshot.generation,a.snapshot.videoId,a.snapshot.fileKey,a.snapshot.size,a.snapshot.contentType],fileKey:a.fileKey});
export function checkContentAttempt(a:LmsContentAttempt):void{
 if(!/^[a-f0-9-]{36}$/i.test(a.id)||a.fileKey===a.snapshot.fileKey||!a.fileKey.startsWith('videos/'+a.grant.ownerUserId+'/video_')||parseReservedBytesFromFileKey(a.fileKey)!==a.snapshot.size||!Number.isSafeInteger(a.snapshot.size)||a.snapshot.size<=0)throw new Error('Invalid content upload attempt');
}
