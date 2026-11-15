import {MaterialsLeaseLostError} from '../contracts/materials-sync-repository';
import {D1_MATERIALS_CONTEXT_LEASE} from './materials-sync-repository';
import type {LmsResource,LmsResourceSyncRepository} from '../contracts/lms-resource-repository';
import {LmsSyncError} from '../../features/lms/resource';
import {buildPendingUploadFileKey,fileExtension,parseReservedBytesFromFileKey} from '../../lib/upload';
import {buildJobMessage,JOB_TRANSCRIBE_VIDEO} from '../../lib/job-message';
import {normalizeLmsResource} from '../../shared/lms-resource-values';
import {enqueueCurrentSceneDeletes,enqueueStagedSceneDeletes} from './scene-index-writer';
const NOW="strftime('%Y-%m-%dT%H:%M:%fZ','now')";
const MONTH="strftime('%Y-%m-%dT%H:%M:%fZ','now','start of month')";
const ACTIVE=`EXISTS(SELECT 1 FROM lms_installations connection JOIN users owner ON owner.id=?
 WHERE connection.id=? AND connection.active=1 AND owner.is_active=1 AND owner.deactivated_at IS NULL
 AND (owner.banned IS NOT TRUE OR julianday(owner.ban_expires)<=julianday('now')))`;
const RESOURCE=`json_object('id',id,'installationId',installation_id,'externalId',external_id,'kind',kind,'contextId',context_id,'resourceLinkId',resource_link_id,
 'generation',generation,'manifestHash',manifest_hash,'enabled',enabled,'contentHash',content_hash,'contentType',content_type,'fileSize',file_size,
 'youtubeVideoId',youtube_video_id,'courseId',course_id,'videoId',video_id,'syncError',sync_error,'updatedAt',updated_at)`;
type Video={id:number;userId:string;status:string;file:string;sourceType:string;youtubeVideoId:string;transcriptionLanguage:string|null;period:string|null;multipart:string|null;managed:number;heartbeat:string|null};
type Mapping={id:string;courseId:number;userId:string|null;managed:number|null;disabled:number|null};
type Course={id:number;userId:string;managed:number;disabled:number};
type Probe={sql:string;values:unknown[];raw:string|null};
function resource(raw:string):LmsResource {const r=JSON.parse(raw) as LmsResource;return normalizeLmsResource({...r,enabled:Boolean(r.enabled)});}
export function createD1LmsResourceSyncRepository(database:D1Database):LmsResourceSyncRepository {
 const prepared=(sql:string,values:unknown[]=[])=>database.prepare(sql).bind(...values);
 async function probes(queries:Array<Omit<Probe,'raw'>>):Promise<Probe[]>{
  const result=await database.batch<{value:string}>(queries.map(q=>prepared(q.sql,q.values)));
  return queries.map((q,i)=>({...q,raw:result[i].results[0]?.value??null}));
 }
 return {async sync(grant,externalId,manifest,manifestHash){
  for(let attempt=0;attempt<5;attempt++){
   const [linkProbe]=await probes([{sql:`SELECT json_object('id',id,'ownerUserId',owner_user_id,'courseId',course_id,'resourceLinkId',resource_link_id) AS value
    FROM teaching_connections WHERE provider='moodle' AND installation_id=? AND context_id=? AND active=1`,values:[grant.id,manifest.contextId]}]);
   const link=linkProbe.raw?JSON.parse(linkProbe.raw) as {id:string;ownerUserId:string;courseId:number;resourceLinkId:string|null}:null;
   if(!link||link.resourceLinkId)throw new LmsSyncError(403,'TEACHER_CONNECTION_REQUIRED');
   const ownerUserId=link.ownerUserId;
   if(grant.ownerUserId && grant.ownerUserId!==ownerUserId)throw new LmsSyncError(403,'INSTALLATION_UNAVAILABLE');
   const authority=grant.materialsLease?`${ACTIVE} AND ${D1_MATERIALS_CONTEXT_LEASE}`:ACTIVE;
   const authorityValues=[ownerUserId,grant.id,...(grant.materialsLease?[grant.materialsLease.id,grant.id,grant.materialsLease.token]:[])];
   if(!await prepared(`SELECT (${authority}) AS allowed`,authorityValues).first<number>('allowed')){
    if(grant.materialsLease && await prepared(`SELECT (${ACTIVE}) AS allowed`,[ownerUserId,grant.id]).first<number>('allowed'))throw new MaterialsLeaseLostError();
    throw new LmsSyncError(403,'INSTALLATION_UNAVAILABLE');
   }
   const [previousProbe,mappingProbe,entryProbe]=await probes([
    {sql:`SELECT ${RESOURCE} AS value FROM lms_resources WHERE installation_id=? AND external_id=?`,values:[grant.id,externalId]},
    {sql:`SELECT json_object('id',m.id,'courseId',m.course_id,'userId',c.user_id,'managed',c.managed_by_lms,'disabled',c.native_access_disabled) AS value
      FROM lms_courses m LEFT JOIN video_courses c ON c.id=m.course_id WHERE m.installation_id=? AND m.context_id=?`,values:[grant.id,manifest.contextId]},
    {sql:"SELECT id AS value FROM lms_resources WHERE installation_id=? AND context_id=? AND kind='course'",values:[grant.id,manifest.contextId]},
   ]);
   const previous=previousProbe.raw?resource(previousProbe.raw):null;
   const mapping=mappingProbe.raw?JSON.parse(mappingProbe.raw) as Mapping:null;
   if(!mapping||mapping.courseId!==link.courseId)throw new LmsSyncError(403,'TEACHER_CONNECTION_REQUIRED');
   const [videoProbe,oldCourseProbe,sharedProbe]=await probes([
    {sql:`SELECT json_object('id',id,'userId',user_id,'status',status,'file',file,'sourceType',source_type,'youtubeVideoId',youtube_video_id,
      'transcriptionLanguage',transcription_language,'period',upload_usage_period_start,'multipart',multipart_upload,'managed',managed_by_lms,'heartbeat',upload_heartbeat_at) AS value FROM videos WHERE id=?`,values:[previous?.videoId??null]},
    {sql:"SELECT json_object('id',id,'userId',user_id,'managed',managed_by_lms,'disabled',native_access_disabled) AS value FROM video_courses WHERE id=?",values:[previous?.courseId??null]},
    {sql:`SELECT CAST((SELECT count(*) FROM lms_resources WHERE video_id=? AND id<>?) +
      (SELECT count(*) FROM video_course_members WHERE video_id=? AND course_id IS NOT ?) AS TEXT) AS value`,values:[previous?.videoId??null,previous?.id??null,previous?.videoId??null,previous?.courseId??null]},
   ]);
   const video=videoProbe.raw?JSON.parse(videoProbe.raw) as Video:null;
   const oldCourse=oldCourseProbe.raw?JSON.parse(oldCourseProbe.raw) as Course:null;
   if(previous && (previous.kind!==(manifest.kind??'video') || previous.kind==='course' && previous.contextId!==manifest.contextId))throw new LmsSyncError(409,'RESOURCE_KIND_OR_CONTEXT_CHANGED');
   if(previous && (manifest.generation<previous.generation || manifest.generation===previous.generation && manifestHash!==previous.manifestHash))throw new LmsSyncError(409,'STALE_GENERATION');
   if(mapping && (mapping.userId!==ownerUserId || manifest.kind==='course' && (!mapping.managed || !mapping.disabled || previous?.courseId!=null && previous.courseId!==mapping.courseId)))throw new LmsSyncError(409,'COURSE_BINDING_CHANGED');
   if(video && (video.userId!==ownerUserId || manifest.kind==='youtube' && (video.sourceType!=='youtube' || video.youtubeVideoId!==previous?.youtubeVideoId)))throw new LmsSyncError(409,'RESOURCE_BINDING_CHANGED');
   const idempotent=previous?.generation===manifest.generation && (!manifest.enabled || (manifest.kind==='course'?mapping!==null:previous.videoId!==null));
   const keep=manifest.kind!=='course' && !manifest.deleted && previous?.videoId!=null && video?.status!=='error' && (manifest.kind==='youtube'
    ?video?.userId===ownerUserId && video.sourceType==='youtube' && previous.youtubeVideoId===(manifest.youtubeVideoId??previous.youtubeVideoId) && video.youtubeVideoId===previous.youtubeVideoId
    :previous.contentHash===(manifest.file?.contentHash??previous.contentHash) && previous.fileSize===(manifest.file?.size??previous.fileSize) && previous.contentType===(manifest.file?.contentType??previous.contentType));
   if(!idempotent && manifest.enabled && keep && manifest.transcriptionLanguage!==undefined && video?.transcriptionLanguage!==manifest.transcriptionLanguage)throw new LmsSyncError(409,'TRANSCRIPTION_LANGUAGE_LOCKED');
   const removing=!idempotent && manifest.kind!=='course' && !keep && video!==null;
   if(removing && Number(sharedProbe.raw)>0)throw new LmsSyncError(409,'SHARED_MATERIAL');
   const fences=[linkProbe,previousProbe,mappingProbe,videoProbe,oldCourseProbe,entryProbe,...(removing?[sharedProbe]:[])];
   const token=crypto.randomUUID(),videoToken=token+':video',courseToken=token+':course',clockToken=token+':month';
   const exists=(receipt=token)=>`EXISTS(SELECT 1 FROM mutation_receipts WHERE token='${receipt}')`;
   // Tokens are internally generated UUIDs. All manifest, identity and snapshot
   // values remain bound parameters; SQL text never includes connector input.
   const statements:D1PreparedStatement[]=[prepared(`INSERT INTO mutation_receipts(token,kind,resource_id) SELECT ?,'lms_sync',0 WHERE (${authority})
    AND ${fences.map(p=>`(${p.sql}) IS ?`).join(' AND ')}`,[token,...authorityValues,...fences.flatMap(p=>[...p.values,p.raw])])];
   if(manifest.kind!=='course'){
    if(video)statements.push(prepared(`UPDATE videos SET managed_by_lms=1 WHERE id=? AND user_id=? AND ${exists()}`,[video.id,ownerUserId]));
    if(oldCourse)statements.push(prepared(`UPDATE video_courses SET managed_by_lms=1,native_access_disabled=1 WHERE id=? AND user_id=? AND ${exists()}`,[oldCourse.id,ownerUserId]));
   }
   if(!idempotent){
    if(manifest.kind!=='course'){
     if(previous?.courseId!=null && previous.videoId!=null){
      if(previous.contextId!==manifest.contextId)statements.push(prepared(`DELETE FROM lti_course_video_tags WHERE video_id=? AND tag_id IN(SELECT id FROM lti_course_tags WHERE course_id=?) AND ${exists()}`,[previous.videoId,previous.courseId]));
      statements.push(prepared(`DELETE FROM video_course_members WHERE course_id=? AND video_id=? AND ${exists()}`,[previous.courseId,previous.videoId]));
     }
     if(removing && video){
      const bytes=parseReservedBytesFromFileKey(video.file);
      const multipart=video.multipart?JSON.parse(video.multipart) as {uploadId:string}:null;
      statements.push(prepared(`INSERT INTO external_tasks(kind,payload,dedupe_key) SELECT 'storage_cleanup',?,? WHERE ${exists()} ON CONFLICT(dedupe_key) DO NOTHING`,
       [JSON.stringify({file_key:video.file,user_id:ownerUserId,bytes,...(multipart?{multipart_upload_id:multipart.uploadId}:{})}),`storage:video:${video.id}`]),
       prepared(`INSERT INTO external_tasks(kind,payload,dedupe_key,available_at) SELECT 'storage_cleanup',?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now','+2 hours') WHERE ${exists()} AND ?='uploading'
        AND EXISTS(SELECT 1 FROM lms_installations WHERE id=? AND materials_service IS NOT NULL) ON CONFLICT(dedupe_key) DO NOTHING`,
        [JSON.stringify({file_key:video.file,user_id:ownerUserId,bytes:null}),`storage:video:${video.id}:late-upload`,video.status,grant.id]),
       enqueueCurrentSceneDeletes(database,video.id,token),enqueueStagedSceneDeletes(database,video.id,token));
      if(video.status==='uploading' && video.period && bytes)statements.push(prepared(`UPDATE users SET used_upload_bytes=max(0,used_upload_bytes-?) WHERE id=? AND julianday(upload_usage_period_start)=julianday(?) AND ${exists()}`,[bytes,ownerUserId,video.period]));
      statements.push(prepared(`DELETE FROM mcp_idempotency_records WHERE user_id=? AND resource_id=? AND action IN('request_video_upload','create_youtube_video') AND ${exists()}`,[ownerUserId,video.id]),
       prepared(`DELETE FROM videos WHERE id=? AND user_id=? AND ${exists()}`,[video.id,ownerUserId]));
     }
     if(manifest.enabled && !keep){
      if(manifest.kind==='youtube'){
       statements.push(prepared(`INSERT INTO videos(user_id,managed_by_lms,title,description,transcript,error_message,file,status,source_type,source_url,youtube_video_id,uploaded_at)
        SELECT ?,1,?,'','','','','pending','youtube',?,?,${NOW} WHERE ${exists()}`,[ownerUserId,manifest.title,'https://www.youtube.com/watch?v='+manifest.youtubeVideoId!,manifest.youtubeVideoId!]),
        prepared(`INSERT INTO mutation_receipts(token,kind,resource_id) SELECT ?,'lms_youtube',last_insert_rowid() WHERE changes()=1`,[videoToken]));
       const message=buildJobMessage(JOB_TRANSCRIBE_VIDEO,{video_id:0});
       statements.push(prepared(`INSERT INTO external_tasks(kind,payload,dedupe_key) SELECT 'sqs_job',json_set(?,'$.message.payload.video_id',resource_id),? FROM mutation_receipts WHERE token=?`,[JSON.stringify({message}),'job:'+message.job_id,videoToken]));
      }else{
       const file=manifest.file!;
       if(!Number.isSafeInteger(file.size) || file.size<=0)throw new Error("Upload reservation bytes must be a positive safe integer.");
       statements.push(prepared(`INSERT INTO mutation_receipts(token,kind,resource_id) SELECT ?,${MONTH},0 WHERE ${exists()}`,[clockToken]));
       const period=`(SELECT kind FROM mutation_receipts WHERE token='${clockToken}')`;
       const usage=`CASE WHEN strftime('%Y-%m',upload_usage_period_start)=strftime('%Y-%m',${period}) THEN used_upload_bytes ELSE 0 END`;
       statements.push(prepared(`INSERT INTO videos(user_id,managed_by_lms,title,description,transcript,error_message,file,status,source_type,source_url,youtube_video_id,uploaded_at,transcription_language,upload_usage_period_start)
        SELECT id,1,?,'','','',?,'uploading','uploaded','','',${NOW},?,${period} FROM users WHERE id=? AND ${exists()}
        AND is_over_quota IS NOT TRUE AND (storage_limit_gb IS NULL OR used_storage_bytes<=floor(storage_limit_gb*1073741824)-?)
        AND (monthly_upload_limit_gb IS NULL OR (${usage})<=floor(monthly_upload_limit_gb*1073741824)-?)
        AND used_storage_bytes<=9007199254740991-? AND (${usage})<=9007199254740991-?`,
        [manifest.title,buildPendingUploadFileKey(ownerUserId,file.size,fileExtension(file.filename)),manifest.transcriptionLanguage??null,ownerUserId,file.size,file.size,file.size,file.size]),
        prepared(`INSERT INTO mutation_receipts(token,kind,resource_id) SELECT ?,'lms_upload',last_insert_rowid() WHERE changes()=1`,[videoToken]),
        prepared(`UPDATE users SET used_storage_bytes=used_storage_bytes+?,used_upload_bytes=(${usage})+?,upload_usage_period_start=${period} WHERE id=? AND ${exists(videoToken)}`,[file.size,file.size,ownerUserId]));
      }
     }else if(manifest.enabled && keep)statements.push(prepared(`UPDATE videos SET title=?,managed_by_lms=1 WHERE id=? AND user_id=? AND ${exists()}`,[manifest.title,previous.videoId,ownerUserId]));
    }
    const chosenVideo=keep?String(previous.videoId):`(SELECT resource_id FROM mutation_receipts WHERE token='${videoToken}')`;
    if(manifest.kind==='course' && manifest.courseTitle || manifest.kind!=='course' && manifest.enabled){
     statements.push(prepared(`UPDATE video_courses SET managed_by_lms=1,native_access_disabled=1,name=coalesce(?,name),updated_at=${NOW} WHERE id=? AND user_id=? AND ${exists()} ${manifest.kind==='course'?'':`AND ${chosenVideo} IS NOT NULL`}`,
      [manifest.kind==='course' || !entryProbe.raw?manifest.courseTitle??null:null,mapping.courseId,ownerUserId]));
    }
    const chosenCourse=String(mapping.courseId);
    if(manifest.kind!=='course' && manifest.enabled)statements.push(prepared(`INSERT INTO video_course_members(course_id,video_id,"order",added_at)
     SELECT ${chosenCourse},${chosenVideo},0,${NOW} WHERE ${exists()} AND ${chosenVideo} IS NOT NULL`));
    const blocked=manifest.kind!=='course' && manifest.kind!=='youtube' && manifest.enabled && !keep;
    const error=blocked?`CASE WHEN ${chosenVideo} IS NULL THEN (SELECT CASE WHEN is_over_quota IS TRUE OR (storage_limit_gb IS NOT NULL AND used_storage_bytes>floor(storage_limit_gb*1073741824)-?)
     THEN 'STORAGE_LIMIT_EXCEEDED' WHEN monthly_upload_limit_gb IS NOT NULL THEN 'MONTHLY_UPLOAD_LIMIT_EXCEEDED' ELSE 'STORAGE_LIMIT_EXCEEDED' END FROM users WHERE id=?) ELSE NULL END`:'NULL';
    const isCourse=manifest.kind==='course';
    statements.push(prepared(`INSERT INTO lms_resources(id,installation_id,external_id,kind,context_id,resource_link_id,generation,manifest_hash,enabled,content_hash,content_type,file_size,youtube_video_id,course_id,video_id,sync_error,updated_at)
     SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,${chosenCourse},${isCourse?'NULL':chosenVideo},${error},${NOW} WHERE ${exists()}
     ON CONFLICT(id) DO UPDATE SET installation_id=excluded.installation_id,external_id=excluded.external_id,kind=excluded.kind,context_id=excluded.context_id,
      resource_link_id=excluded.resource_link_id,generation=excluded.generation,manifest_hash=excluded.manifest_hash,enabled=excluded.enabled,content_hash=excluded.content_hash,
      content_type=excluded.content_type,file_size=excluded.file_size,youtube_video_id=excluded.youtube_video_id,course_id=excluded.course_id,video_id=excluded.video_id,sync_error=excluded.sync_error,updated_at=excluded.updated_at`,
     [previous?.id??crypto.randomUUID(),grant.id,externalId,manifest.kind??'video',manifest.contextId,manifest.resourceLinkId,manifest.generation,manifestHash,manifest.enabled?1:0,
      isCourse || manifest.deleted?null:manifest.file?.contentHash??previous?.contentHash??null,isCourse || manifest.deleted?null:manifest.file?.contentType??previous?.contentType??null,
      isCourse || manifest.deleted?null:manifest.file?.size??previous?.fileSize??null,manifest.kind==='youtube'?manifest.youtubeVideoId??previous?.youtubeVideoId??null:null,...(blocked?[manifest.file!.size,ownerUserId]:[])]));
   }
   statements.push(prepared(`SELECT ${RESOURCE} AS value FROM lms_resources WHERE installation_id=? AND external_id=? AND ${exists()}`,[grant.id,externalId]),
    prepared('DELETE FROM mutation_receipts WHERE token IN(?,?,?,?)',[token,videoToken,courseToken,clockToken]));
   const result=await database.batch<{value:string}>(statements);
   const saved=result[result.length-2].results[0];if(saved)return resource(saved.value);
  }
  throw new LmsSyncError(409,'RESOURCE_CHANGED_RETRY');
 }};
}
