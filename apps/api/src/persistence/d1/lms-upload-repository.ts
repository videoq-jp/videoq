import type {LmsUploadRepository,LmsUploadSnapshot} from '../contracts/lms-upload-repository';
import type {OwnedLmsGrant} from '../contracts/lms-resource-repository';
import {contentSlot,contentCleanup,contentPayload,checkContentAttempt} from '../../shared/lms-upload';
import {buildJobMessage,JOB_TRANSCRIBE_VIDEO} from '../../lib/job-message';
const SOURCE=`SELECT v.id,v.status FROM lms_resources r JOIN videos v ON v.id=r.video_id JOIN lms_installations i ON i.id=r.installation_id JOIN teaching_connections t ON t.provider='moodle' AND t.installation_id=i.id AND t.context_id=r.context_id AND t.course_id=r.course_id AND t.active=1 AND t.resource_link_id IS NULL JOIN video_courses course ON course.id=t.course_id AND course.user_id=t.owner_user_id JOIN users owner ON owner.id=t.owner_user_id
 WHERE i.id=? AND owner.id=? AND r.id=? AND r.external_id=? AND r.generation=? AND v.id=? AND v.file=? AND r.file_size=? AND r.content_type=?
 AND r.enabled=1 AND r.kind='video' AND v.user_id=owner.id AND v.managed_by_lms=1 AND v.source_type='uploaded'
 AND i.active=1 AND owner.is_active=1 AND owner.deactivated_at IS NULL AND (owner.banned IS NOT TRUE OR julianday(owner.ban_expires)<=julianday('now'))`;
const sourceArgs=(g:OwnedLmsGrant,s:LmsUploadSnapshot)=>[g.id,g.ownerUserId,s.resourceId,s.externalId,s.generation,s.videoId,s.fileKey,s.size,s.contentType];
const LIVE=`EXISTS(SELECT 1 FROM lti_credentials c WHERE c.id=? AND c.kind='lms-content-upload' AND json(c.payload)=json(?) AND julianday(c.expires_at)>julianday('now'))`;
export function createD1LmsUploadRepository(database:D1Database):LmsUploadRepository{
 const prepare=(sql:string,args:unknown[]=[])=>database.prepare(sql).bind(...args);
 return {
  async prepare(a){
   checkContentAttempt(a);const payload=contentPayload(a),slot=contentSlot(a.snapshot);
   const result=await database.batch([
    prepare(`INSERT INTO lti_credentials(id,kind,payload,expires_at) SELECT ?,'lms-content-upload',?,strftime('%Y-%m-%dT%H:%M:%fZ','now','+15 minutes') WHERE EXISTS(${SOURCE} AND v.status='uploading') AND (NOT EXISTS(SELECT 1 FROM external_tasks WHERE dedupe_key=?) OR ${LIVE})
     ON CONFLICT(id) DO UPDATE SET payload=excluded.payload,expires_at=excluded.expires_at WHERE lti_credentials.kind='lms-content-upload' AND julianday(lti_credentials.expires_at)<=julianday('now')`,[slot,payload,...sourceArgs(a.grant,a.snapshot),contentCleanup(a.id),slot,payload]),
    prepare(`INSERT INTO external_tasks(kind,payload,dedupe_key,available_at) SELECT 'storage_cleanup',?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now','+2 hours') WHERE ${LIVE} ON CONFLICT(dedupe_key) DO NOTHING`,[JSON.stringify({file_key:a.fileKey,user_id:a.grant.ownerUserId,bytes:0}),contentCleanup(a.id),slot,payload]),
    prepare(`SELECT id FROM lti_credentials WHERE id=? AND kind='lms-content-upload' AND json(payload)=json(?) AND EXISTS(${SOURCE} AND v.status='uploading')`,[slot,payload,...sourceArgs(a.grant,a.snapshot)]),
   ]);return Boolean(result[2].results.length);
  },
  async adopt(a){
   checkContentAttempt(a);const token=crypto.randomUUID(),slot=contentSlot(a.snapshot),payload=contentPayload(a),gate='EXISTS(SELECT 1 FROM mutation_receipts WHERE token=?)';
   const result=await database.batch([
    prepare(`INSERT INTO mutation_receipts(token,kind,resource_id) SELECT ?,'lms_content_adopt',? WHERE EXISTS(${SOURCE} AND v.status='uploading') AND ${LIVE}
     AND EXISTS(SELECT 1 FROM external_tasks WHERE dedupe_key=? AND kind='storage_cleanup' AND json_extract(payload,'$.file_key')=? AND attempts=0 AND locked_at IS NULL AND completed_at IS NULL AND dead_at IS NULL AND julianday(available_at)>julianday('now'))`,[token,a.snapshot.videoId,...sourceArgs(a.grant,a.snapshot),slot,payload,contentCleanup(a.id),a.fileKey]),
    prepare(`UPDATE videos SET file=?,upload_heartbeat_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND ${gate}`,[a.fileKey,a.snapshot.videoId,token]),
    // The candidate is now canonical; its delayed cleanup retires the old key instead.
    prepare(`UPDATE external_tasks SET payload=json_set(payload,'$.file_key',?) WHERE dedupe_key=? AND ${gate}`,[a.snapshot.fileKey,contentCleanup(a.id),token]),
    prepare(`DELETE FROM lti_credentials WHERE id=? AND json(payload)=json(?) AND ${gate}`,[slot,payload,token]),
    prepare('SELECT token FROM mutation_receipts WHERE token=?',[token]),prepare('DELETE FROM mutation_receipts WHERE token=?',[token]),
   ]);return Boolean(result[4].results.length);
  },
  async abandon(a){
   checkContentAttempt(a);
   await database.batch([
    prepare(`INSERT INTO external_tasks(kind,payload,dedupe_key) SELECT 'storage_cleanup',?,? WHERE NOT EXISTS(SELECT 1 FROM videos WHERE file=?)
     AND EXISTS(SELECT 1 FROM external_tasks WHERE dedupe_key=? AND kind='storage_cleanup' AND json_extract(payload,'$.file_key')=?) ON CONFLICT(dedupe_key) DO NOTHING`,[JSON.stringify({file_key:a.fileKey,user_id:a.grant.ownerUserId,bytes:0}),'lms-content-abandon:'+a.id,a.fileKey,contentCleanup(a.id),a.fileKey]),
    prepare("DELETE FROM lti_credentials WHERE id=? AND kind='lms-content-upload' AND json(payload)=json(?)",[contentSlot(a.snapshot),contentPayload(a)]),
   ]);
  },
  async confirm(grant,snapshot,objectVerified){
   const message=buildJobMessage(JOB_TRANSCRIBE_VIDEO,{video_id:snapshot.videoId}),dedupe='job:'+message.job_id;
   const result=await database.batch<Record<string,unknown>>([
    prepare(`INSERT INTO external_tasks(kind,payload,dedupe_key) SELECT 'sqs_job',?,? WHERE ?=1 AND EXISTS(${SOURCE} AND v.status='uploading')`,[JSON.stringify({message}),dedupe,objectVerified?1:0,...sourceArgs(grant,snapshot)]),
    prepare("UPDATE videos SET status='pending',error_message='' WHERE id=? AND changes()=1",[snapshot.videoId]),
    prepare('SELECT id FROM external_tasks WHERE dedupe_key=?',[dedupe]),prepare(SOURCE,sourceArgs(grant,snapshot)),
   ]);const task=result[2].results[0];if(task)return {status:'queued',job:{videoId:snapshot.videoId,taskId:Number(task.id),jobId:message.job_id}};
   const status=result[3].results[0]?.status;return typeof status==='string'&&['pending','processing','indexing','completed','error'].includes(status)?{status:'already'}:{status:'stale'};
  },
 };
}
