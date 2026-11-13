import {createLmsUploadRepository} from '../../persistence/factory';
import type {OwnedLmsGrant,LmsResourceData} from '../../persistence/contracts/lms-resource-repository';
import type {LmsUploadSnapshot} from '../../persistence/contracts/lms-upload-repository';
import {buildPendingUploadFileKey,fileExtension} from '../../lib/upload';
import {deadlineSignal} from '../../lib/request-timeout';
import {armMaintenance} from '../../lib/task-scheduler';
import {processExternalTaskById} from '../../lib/external-tasks';
import {getR2ObjectSize,putMediaObject} from '../../integrations/media';
import type {Bindings} from '../../types/bindings';
import {LmsSyncError} from './resource';
import {lmsUploadStream} from './upload';
export function lmsUploadSnapshot(data:LmsResourceData|null,externalId:string,generation:number):LmsUploadSnapshot{
 if(!data?.video||data.resource.kind!=='video'||!data.resource.enabled||data.resource.generation!==generation||data.resource.fileSize===null||!data.resource.contentType)throw new LmsSyncError(409,'STALE_GENERATION');
 return {resourceId:data.resource.id,externalId,generation,videoId:data.video.id,fileKey:data.video.file,size:data.resource.fileSize,contentType:data.resource.contentType};
}
export async function uploadLmsContent(env:Bindings,grant:OwnedLmsGrant,snapshot:LmsUploadSnapshot,body:ReadableStream<Uint8Array>,callerSignal?:AbortSignal){
 const repository=await createLmsUploadRepository(env),attempt={id:crypto.randomUUID(),grant,snapshot,fileKey:buildPendingUploadFileKey(grant.ownerUserId,snapshot.size,fileExtension(snapshot.fileKey))};
 if(!await repository.prepare(attempt))throw new LmsSyncError(409,'UPLOAD_UNAVAILABLE');
 await armMaintenance(env,Date.now()+2*3600000);
 const signal=deadlineSignal(10*60000,callerSignal);
 try{
  await putMediaObject(env,attempt.fileKey,lmsUploadStream(body,snapshot.size,signal),snapshot.contentType);
  if(signal.aborted)throw new LmsSyncError(409,'UPLOAD_EXPIRED');
  if(!await repository.adopt(attempt))throw new LmsSyncError(409,'STALE_GENERATION');
 }catch(error){
  try{await repository.abandon(attempt);}catch{console.error(JSON.stringify({event:'lms_upload_cleanup_deferred'}));}
  await armMaintenance(env,Date.now());
  if(signal.aborted)throw new LmsSyncError(409,'UPLOAD_EXPIRED');
  throw error;
 }
}
export async function confirmLmsUpload(env:Bindings,grant:OwnedLmsGrant,snapshot:LmsUploadSnapshot,status:string){
 if(status==='uploading'&&await getR2ObjectSize(env,snapshot.fileKey)!==snapshot.size)throw new LmsSyncError(409,'UPLOAD_NOT_CONFIRMED');
 const result=await (await createLmsUploadRepository(env)).confirm(grant,snapshot,status==='uploading');
 if(result.status==='stale')throw new LmsSyncError(409,'STALE_GENERATION');
 if(result.status==='queued')await processExternalTaskById(env,result.job.taskId);
}
