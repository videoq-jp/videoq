import type pg from 'pg';
import {withClient} from '../../db/pool';
import type {Bindings} from '../../types/bindings';
import type {LmsUploadRepository,LmsUploadSnapshot} from '../contracts/lms-upload-repository';
import type {OwnedLmsGrant} from '../contracts/lms-resource-repository';
import {contentSlot,contentCleanup,contentPayload,checkContentAttempt} from '../../shared/lms-upload';
import {buildJobMessage,JOB_TRANSCRIBE_VIDEO} from '../../lib/job-message';
const SOURCE=`SELECT v.id,v.status FROM lms_resources r JOIN videos v ON v.id=r.video_id JOIN lms_installations i ON i.id=r.installation_id JOIN teaching_connections t ON t.provider='moodle' AND t.installation_id=i.id AND t.context_id=r.context_id AND t.course_id=r.course_id AND t.active=true AND t.resource_link_id IS NULL JOIN video_courses course ON course.id=t.course_id AND course.user_id=t.owner_user_id JOIN users owner ON owner.id=t.owner_user_id
 WHERE i.id=$1 AND owner.id=$2 AND r.id=$3 AND r.external_id=$4 AND r.generation=$5 AND v.id=$6 AND v.file=$7 AND r.file_size=$8 AND r.content_type=$9
 AND r.enabled=true AND r.kind='video' AND v.user_id=owner.id AND v.managed_by_lms=true AND v.source_type='uploaded'
 AND i.active=true AND owner.is_active=true AND owner.deactivated_at IS NULL AND (owner.banned IS NOT TRUE OR owner.ban_expires<=clock_timestamp()) FOR UPDATE OF r,v`;
const sourceArgs=(g:OwnedLmsGrant,s:LmsUploadSnapshot)=>[g.id,g.ownerUserId,s.resourceId,s.externalId,s.generation,s.videoId,s.fileKey,s.size,s.contentType];
export function createPostgresLmsUploadRepository(env:Bindings):LmsUploadRepository{
 async function write<T>(grant:OwnedLmsGrant,operation:(client:pg.Client)=>Promise<T>):Promise<T>{return withClient(env,async client=>{
  await client.query('BEGIN');try{
   await client.query('SELECT id FROM users WHERE id=$1 FOR UPDATE',[grant.ownerUserId]);
   await client.query('SELECT id FROM lms_installations WHERE id=$1 FOR UPDATE',[grant.id]);
   const result=await operation(client);await client.query('COMMIT');return result;
  }catch(error){await client.query('ROLLBACK');throw error;}
 });}
 return {
  async prepare(a){checkContentAttempt(a);return write(a.grant,async client=>{
   const source=(await client.query<{status:string}>(SOURCE,sourceArgs(a.grant,a.snapshot))).rows[0];if(source?.status!=='uploading')return false;
   const slot=contentSlot(a.snapshot),payload=contentPayload(a);
   const prior=await client.query('SELECT id FROM external_tasks WHERE dedupe_key=$1',[contentCleanup(a.id)]);
   if(prior.rowCount&&!(await client.query("SELECT id FROM lti_credentials WHERE id=$1 AND kind='lms-content-upload' AND payload=$2::jsonb AND expires_at>clock_timestamp()",[slot,payload])).rowCount)return false;
   await client.query(`INSERT INTO lti_credentials(id,kind,payload,expires_at) VALUES($1,'lms-content-upload',$2::jsonb,clock_timestamp()+interval '15 minutes')
    ON CONFLICT(id) DO UPDATE SET payload=excluded.payload,expires_at=excluded.expires_at WHERE lti_credentials.kind='lms-content-upload' AND lti_credentials.expires_at<=clock_timestamp()`,[slot,payload]);
   if(!(await client.query("SELECT id FROM lti_credentials WHERE id=$1 AND kind='lms-content-upload' AND payload=$2::jsonb AND expires_at>clock_timestamp()",[slot,payload])).rowCount)return false;
   await client.query(`INSERT INTO external_tasks(kind,payload,dedupe_key,available_at) VALUES('storage_cleanup',$1::jsonb,$2,clock_timestamp()+interval '2 hours') ON CONFLICT(dedupe_key) DO NOTHING`,[JSON.stringify({file_key:a.fileKey,user_id:a.grant.ownerUserId,bytes:0}),contentCleanup(a.id)]);return true;
  });},
  async adopt(a){checkContentAttempt(a);return write(a.grant,async client=>{
   const source=(await client.query<{status:string}>(SOURCE,sourceArgs(a.grant,a.snapshot))).rows[0];if(source?.status!=='uploading')return false;
   const slot=contentSlot(a.snapshot),payload=contentPayload(a);
   if(!(await client.query("SELECT id FROM lti_credentials WHERE id=$1 AND kind='lms-content-upload' AND payload=$2::jsonb AND expires_at>clock_timestamp() FOR UPDATE",[slot,payload])).rowCount)return false;
   const task=await client.query(`SELECT id FROM external_tasks WHERE dedupe_key=$1 AND kind='storage_cleanup' AND payload->>'file_key'=$2
    AND attempts=0 AND locked_at IS NULL AND completed_at IS NULL AND dead_at IS NULL AND available_at>clock_timestamp() FOR UPDATE`,[contentCleanup(a.id),a.fileKey]);if(!task.rowCount)return false;
   // Recheck clock time after potentially waiting for the cleanup row lock.
   if(!(await client.query('SELECT id FROM lti_credentials WHERE id=$1 AND expires_at>clock_timestamp()',[slot])).rowCount)return false;
   await client.query('UPDATE videos SET file=$1,upload_heartbeat_at=clock_timestamp() WHERE id=$2',[a.fileKey,a.snapshot.videoId]);
   await client.query("UPDATE external_tasks SET payload=jsonb_set(payload,'{file_key}',to_jsonb($1::text)) WHERE dedupe_key=$2",[a.snapshot.fileKey,contentCleanup(a.id)]);
   await client.query('DELETE FROM lti_credentials WHERE id=$1',[slot]);return true;
  });},
  async abandon(a){checkContentAttempt(a);await write(a.grant,async client=>{
    await client.query(`INSERT INTO external_tasks(kind,payload,dedupe_key) SELECT 'storage_cleanup',$1::jsonb,$2 WHERE NOT EXISTS(SELECT 1 FROM videos WHERE file=$3)
     AND EXISTS(SELECT 1 FROM external_tasks WHERE dedupe_key=$4 AND kind='storage_cleanup' AND payload->>'file_key'=$3) ON CONFLICT(dedupe_key) DO NOTHING`,[JSON.stringify({file_key:a.fileKey,user_id:a.grant.ownerUserId,bytes:0}),'lms-content-abandon:'+a.id,a.fileKey,contentCleanup(a.id)]);
    await client.query("DELETE FROM lti_credentials WHERE id=$1 AND kind='lms-content-upload' AND payload=$2::jsonb",[contentSlot(a.snapshot),contentPayload(a)]);
  });},
  confirm:(grant,snapshot,objectVerified)=>write(grant,async client=>{
   const source=(await client.query<{status:string}>(SOURCE,sourceArgs(grant,snapshot))).rows[0];if(!source)return {status:'stale'};
   if(source.status!=='uploading')return ['pending','processing','indexing','completed','error'].includes(source.status)?{status:'already'}:{status:'stale'};
   if(!objectVerified)return {status:'stale'};
   const message=buildJobMessage(JOB_TRANSCRIBE_VIDEO,{video_id:snapshot.videoId});
   await client.query("UPDATE videos SET status='pending',error_message='' WHERE id=$1",[snapshot.videoId]);
   const task=await client.query<{id:string}>("INSERT INTO external_tasks(kind,payload,dedupe_key) VALUES('sqs_job',$1::jsonb,$2) RETURNING id",[JSON.stringify({message}),'job:'+message.job_id]);
   return {status:'queued',job:{videoId:snapshot.videoId,taskId:Number(task.rows[0].id),jobId:message.job_id}};
  }),
 };
}
