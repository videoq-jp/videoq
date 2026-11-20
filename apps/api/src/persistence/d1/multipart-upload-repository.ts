import { uploadConfirmed, assertMultipartInitialization, activeMultipartSession, multipartReservation, multipartPartLength, orderedMultipartParts, multipartObjectMatches, assertMultipartObjectSize } from '../../application/multipart-upload';
import {multipartPartSize} from '@videoq/domain/video-upload';
import {UploadSessionError,type MultipartUploadRepository} from '../contracts/multipart-upload-repository';
import {createR2MultipartUpload,completeR2MultipartUpload,getR2ObjectSize,presignR2UploadPart} from '../../integrations/media';
import {parseReservedBytesFromFileKey} from '../../application/upload';
import {buildJobMessage,JOB_TRANSCRIBE_VIDEO} from '../../lib/job-message';
import {armMaintenance} from '../../lib/task-scheduler';
import {sha256Hex} from '../../shared/crypto';
import type {Bindings} from '../../types/bindings';
type Session={uploadId:string;contentType:string;partSize:number};
type Video={file:string;status:string;multipart_upload:string|null};
const NOW="strftime('%Y-%m-%dT%H:%M:%fZ','now')";
export function createD1MultipartUploadRepository(database:D1Database,env:Bindings):MultipartUploadRepository{
 const prepare=(query:string,args:unknown[]=[])=>database.prepare(query).bind(...args);
 const read=async(id:number,user:string)=>{const row=await prepare('SELECT file,status,multipart_upload FROM videos WHERE id=? AND user_id=?',[id,user]).first<Video>();if(!row)throw new UploadSessionError('Video not found','NOT_FOUND');return row;};
 const matches='id=? AND user_id=? AND file=? AND status=\'uploading\' AND json(multipart_upload) IS json(?)';
 const args=(id:number,user:string,v:Video)=>[id,user,v.file,v.multipart_upload];
 const active=(v:Video)=>JSON.parse(activeMultipartSession(v.status,v.multipart_upload)) as Session;
 const sizeOf=(v:Video)=>multipartReservation(parseReservedBytesFromFileKey(v.file));
 const cleanupKey=async(file:string,uploadId:string)=>'multipart-abort:'+await sha256Hex(JSON.stringify([file,uploadId]));
 const abandon=async(file:string,user:string,uploadId:string)=>{
  const key=await cleanupKey(file,uploadId);
  await prepare(`INSERT INTO external_tasks(kind,payload,dedupe_key) SELECT 'multipart_abort',?,? WHERE NOT EXISTS(SELECT 1 FROM videos WHERE file=? AND json_extract(multipart_upload,'$.uploadId')=?) ON CONFLICT DO NOTHING`,[JSON.stringify({file_key:file,user_id:user,bytes:0,multipart_upload_id:uploadId}),key,file,uploadId]).run();
  await armMaintenance(env,Date.now()+1000);
 };
 return {
  async initialize(id,user,contentType){
   let created:{file:string;uploadId:string}|undefined;
   try{
    for(let attempt=0;attempt<5;attempt++){
     const v=await read(id,user);assertMultipartInitialization(v.status);const size=sizeOf(v);
     let session=v.multipart_upload?JSON.parse(v.multipart_upload) as Session:null;
     if(!session){
      const uploadId=await createR2MultipartUpload(env,v.file,contentType);created={file:v.file,uploadId};session={uploadId,contentType,partSize:multipartPartSize(size)};
      const key=await cleanupKey(v.file,uploadId);
      const adopted=await prepare(`UPDATE videos SET multipart_upload=?,upload_heartbeat_at=${NOW} WHERE ${matches} AND NOT EXISTS(SELECT 1 FROM external_tasks WHERE dedupe_key=?) RETURNING id`,[JSON.stringify(session),...args(id,user,v),key]).all();
      if(!adopted.results.length){await abandon(v.file,user,uploadId);created=undefined;continue;}
     }else{
      const touched=await prepare(`UPDATE videos SET upload_heartbeat_at=${NOW} WHERE ${matches} RETURNING id`,args(id,user,v)).all();if(!touched.results.length)continue;
     }
     return {part_size:session.partSize,part_count:Math.ceil(size/session.partSize)};
    }
    throw new UploadSessionError('Upload session changed; retry initialization');
   }catch(error){
    if(created)try{await abandon(created.file,user,created.uploadId);}catch{console.error(JSON.stringify({event:'multipart_initialization_cleanup_deferred',videoId:id}));}
    throw error;
   }
  },
  async partUrl(id,user,partNumber){
   const v=await read(id,user),session=active(v),size=sizeOf(v);
   const length=multipartPartLength(size,session.partSize,partNumber);
   const upload_url=await presignR2UploadPart(env,v.file,session.uploadId,partNumber,session.contentType,length);
   const touched=await prepare(`UPDATE videos SET upload_heartbeat_at=${NOW} WHERE ${matches} RETURNING id`,args(id,user,v)).all();if(!touched.results.length)throw new UploadSessionError('Upload session changed');
   return {upload_url};
  },
  async complete(id,user,parts){
   const v=await read(id,user);if(uploadConfirmed(v.status))return null;
   const session=active(v),size=sizeOf(v),ordered=orderedMultipartParts(size,session.partSize,parts);
   // Keep a delayed orphan cleanup before storage I/O, including crashes or a
   // completion arriving after video deletion's immediate cleanup.
   await armMaintenance(env,Date.now()+1000);
   const finishKey='multipart-finish:'+await sha256Hex(JSON.stringify([v.file,session.uploadId]));
   await prepare(`INSERT INTO external_tasks(kind,payload,dedupe_key,available_at) VALUES('multipart_cleanup',?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now','+2 hours'))
    ON CONFLICT(dedupe_key) DO UPDATE SET completed_at=NULL,dead_at=NULL,available_at=excluded.available_at
    WHERE external_tasks.locked_at IS NULL AND (external_tasks.completed_at IS NOT NULL OR external_tasks.dead_at IS NOT NULL)`,[JSON.stringify({file_key:v.file,user_id:user,bytes:0,multipart_upload_id:session.uploadId}),finishKey]).run();
   let actual=await getR2ObjectSize(env,v.file);
   if(actual===null){
    try{await completeR2MultipartUpload(env,v.file,session.uploadId,ordered);}catch(error){if(!multipartObjectMatches(await getR2ObjectSize(env,v.file),size))throw error;}
    actual=await getR2ObjectSize(env,v.file);
   }
   assertMultipartObjectSize(actual,size);
   const message=buildJobMessage(JOB_TRANSCRIBE_VIDEO,{video_id:id}),key='job:'+message.job_id;
   const result=await database.batch<Record<string,unknown>>([
    prepare(`INSERT INTO external_tasks(kind,payload,dedupe_key) SELECT 'sqs_job',?,? WHERE EXISTS(SELECT 1 FROM videos WHERE ${matches})`,[JSON.stringify({message}),key,...args(id,user,v)]),
    prepare(`UPDATE videos SET status='pending',error_message='',multipart_upload=NULL,upload_heartbeat_at=NULL WHERE changes()=1 AND ${matches}`,args(id,user,v)),
    prepare('SELECT id FROM external_tasks WHERE dedupe_key=?',[key]),
   ]);
   if(result[2].results[0])return Number(result[2].results[0].id);
   const current=await read(id,user);if(current.file===v.file&&uploadConfirmed(current.status))return null;
   throw new UploadSessionError('Upload session changed before confirmation');
  },
  async hasUploadingFile(file){return Boolean(await prepare("SELECT id FROM videos WHERE file=? AND status='uploading' LIMIT 1",[file]).first());},
  async referencesFile(file,uploadId){return Boolean(await prepare(`SELECT id FROM videos WHERE file=? ${uploadId===undefined?'':"AND json_extract(multipart_upload,'$.uploadId')=?"} LIMIT 1`,uploadId===undefined?[file]:[file,uploadId]).first());},
 };
}
