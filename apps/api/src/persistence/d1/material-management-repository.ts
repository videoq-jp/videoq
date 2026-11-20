import { assertMaterialGeneration, assertMaterialReferences, assertMaterialReadable, assertMaterialReplayIdentity, assertMaterialOperationAvailable, assertMaterialRevision, materialMutationKind, planMaterialMutation } from '../../application/material-mutation';
import { inlineTranscript, inlineMaterialDescription } from '../../application/content-read';
import { contentStringLogic } from '../content-read-policy-sql';
import { d1LmsOwnerSql } from './lms-owner-policy';
import type {MaterialManagementRepository,ManagedMaterialScope,ManagedVideo,MaterialJob} from '../contracts/material-management-repository';
import {materialConflict as conflict,revisionOf,originalMessage,materialView,checkMaterialManagement} from '../../shared/material-management';
import {ApiError,apiNotFound,asApiError} from '../../shared/errors';
import {buildJobMessage,type JobMessage} from '../../lib/job-message';
import {digest} from '../../features/lti/store';
import {operationReservationKey} from '../../shared/lti-operation-key';
import {enqueueCurrentSceneDeletes,enqueueStagedSceneDeletes} from './scene-index-writer';
const VIDEO=`(SELECT json_object('title',title,'file',file,'status',status,
 'description',${inlineMaterialDescription('description','length(CAST(description AS BLOB))',contentStringLogic)},
 'transcript',${inlineTranscript('transcript','length(CAST(transcript AS BLOB))',contentStringLogic).value},
 'sourceRevision',(SELECT revision FROM video_index_versions WHERE video_id=v.id)) FROM videos v WHERE id=? AND user_id=? AND managed_by_lms=1)`;
const RESOURCE=`(SELECT json_object('id',id,'generation',generation) FROM lms_resources WHERE installation_id=? AND context_id=? AND resource_link_id=? AND course_id=? AND video_id=? AND enabled=1)`;
const REFS=`json_object('courses',json((SELECT json_group_array(course_id) FROM(SELECT course_id FROM video_course_members WHERE video_id=? ORDER BY course_id))),
 'resources',json((SELECT json_group_array(id) FROM(SELECT id FROM lms_resources WHERE video_id=? ORDER BY id))))`;
function job(transcribeOnly=false){return `(SELECT json_object('id',e.id,'message',json(e.payload -> '$.message'),'dead',json(CASE WHEN e.dead_at IS NOT NULL THEN 'true' ELSE 'false' END),'status',j.status)
 FROM external_tasks e LEFT JOIN job_executions j ON j.job_id=e.payload ->> '$.message.job_id'
 WHERE e.kind='sqs_job' AND e.payload ->> '$.message.payload.video_id' IN(?,?)
 AND e.payload ->> '$.message.type' IN(${transcribeOnly?"'transcribe_video'":"'transcribe_video','index_video_transcript','reindex_video_transcript'"}) ORDER BY e.created_at DESC,e.id DESC LIMIT 1)`;}
const BUSY=`EXISTS(SELECT 1 FROM job_executions j WHERE j.status='running' AND julianday(j.lease_until)>julianday('now')
 AND (j.job_type='reindex_all_videos_embeddings' OR EXISTS(SELECT 1 FROM external_tasks e WHERE e.kind='sqs_job'
 AND e.payload ->> '$.message.job_id'=j.job_id AND e.payload ->> '$.message.payload.video_id' IN(?,?))))`;
function authority(scope:ManagedMaterialScope){const proof=scope.sessionProof;return {sql:`EXISTS(SELECT 1 FROM lms_installations i JOIN teaching_connections t ON t.provider='moodle' AND t.installation_id=i.id AND t.context_id=? AND t.course_id=? AND t.active=1 JOIN users owner ON owner.id=t.owner_user_id
 WHERE i.id=? AND owner.id=? AND i.active=1 AND ${d1LmsOwnerSql()}
 ${proof?`AND EXISTS(SELECT 1 FROM lti_credentials s WHERE s.id=? AND s.kind='session' AND julianday(s.expires_at)>julianday('now') AND json_extract(s.payload,'$.registrationId')=? AND json_extract(s.payload,'$.subjectHash')=?)`:''})`,
 values:[scope.contextId,scope.courseId,scope.installationId,scope.ownerUserId,...(proof?[proof.sessionHash,proof.registrationId,proof.subjectHash]:[])]};}
const decode=<T>(raw:unknown):T|undefined=>{if(raw===null||raw===undefined)return undefined;if(typeof raw!=='string')throw new Error('Invalid material JSON');return JSON.parse(raw) as T;};
export function createD1MaterialManagementRepository(database:D1Database):MaterialManagementRepository{return {async execute(scope,input){
 try {
 checkMaterialManagement(scope,input);
 const prepare=(sql:string,args:unknown[]=[])=>database.prepare(sql).bind(...args),auth=authority(scope);
 const resourceArgs=[scope.installationId,scope.contextId,scope.resourceLinkId,scope.courseId,scope.videoId],videoArgs=[scope.videoId,scope.ownerUserId],jobArgs=[scope.videoId,String(scope.videoId)];
 const course=`EXISTS(SELECT 1 FROM video_courses WHERE id=? AND user_id=? AND managed_by_lms=1)`,courseArgs=[scope.courseId,scope.ownerUserId];
 const id=input.action==='get'?'':input.operationId.toLowerCase(),key=await operationReservationKey('material',id),requestHash=input.action==='get'?'':await digest(JSON.stringify(input));
 for(let attempt=0;attempt<5;attempt++){
  const snapshot=await database.batch<Record<string,unknown>>([
   prepare(`SELECT (${auth.sql}) AS allowed,${RESOURCE} AS resource,(${course}) AS course,${REFS} AS refs,${VIDEO} AS video,${job()} AS job,${job(true)} AS retryJob,(${BUSY}) AS busy`,
    [...auth.values,...resourceArgs,...courseArgs,scope.videoId,scope.videoId,...videoArgs,...jobArgs,...jobArgs,...jobArgs]),
   prepare('SELECT actor_key,resource_id,request_hash,external_task_id FROM lti_material_operations WHERE id=?',[id]),
   prepare('SELECT key FROM lti_operation_reservations WHERE key=?',[key]),
  ]);
  const state=snapshot[0].results[0];if(!state.allowed)throw new ApiError(403,'FORBIDDEN','The material is unavailable.');
  const resource=decode<{id:string;generation:number}>(state.resource);if(!resource||!state.course)throw apiNotFound('Material not found.');
  assertMaterialGeneration(Number(resource.generation),scope.generation);
  const refs=decode<{courses:number[];resources:string[]}>(state.refs)!;
  assertMaterialReferences(refs.courses.length,Number(refs.courses[0]),refs.resources.length,scope.courseId);
  const video=decode<ManagedVideo>(state.video);if(!video)throw apiNotFound('Material not found.');
  assertMaterialReadable(video);
  const latest=decode<MaterialJob>(state.job),retryJob=decode<MaterialJob>(state.retryJob);
  if(input.action==='get')return {material:await materialView(scope,video,latest,video.status==='error'?retryJob:undefined),externalTaskId:null,reused:false};
  if(state.busy)throw conflict('This material is being indexed. Try again after processing finishes.');
  const prior=snapshot[1].results[0];
  if(prior)assertMaterialReplayIdentity(prior.actor_key===scope.actorKey,prior.resource_id===resource.id,prior.request_hash===requestHash);
  else assertMaterialOperationAvailable(snapshot[2].results.length===0);
  const beforeRevision=await revisionOf(scope,video);let next={...video},message:JobMessage|undefined,indexChanged=false;
  if(!prior){
   assertMaterialRevision(beforeRevision,input.revision);
   const kind=materialMutationKind(input,video.status);
   // D1's physical binding limit is checked after the shared edit admission.
   if(input.action==='update'&&input.fields.transcript!==undefined&&new TextEncoder().encode(input.fields.transcript).length>1_800_000)throw new ApiError(413,'VALIDATION_ERROR','Transcript is too large.');
   const original=kind==='retry'?originalMessage.safeParse(retryJob?.message):undefined;
   const plan=planMaterialMutation(input,video,original?.success?original.data:undefined,retryJob?.status);
   next=plan.next;indexChanged=plan.indexChanged;
   if(plan.job)message=plan.job.kind==='index'?buildJobMessage('index_video_transcript',plan.job.payload):plan.job.message;
  }
  const token=crypto.randomUUID(),gate='EXISTS(SELECT 1 FROM mutation_receipts WHERE token=?)',dedupeKey='lti-material:'+input.operationId;
  const priorGuard=prior?`EXISTS(SELECT 1 FROM lti_material_operations WHERE id=? AND actor_key=? AND resource_id=? AND request_hash=? AND external_task_id IS ?)`
   :`NOT EXISTS(SELECT 1 FROM lti_material_operations WHERE id=?) AND NOT EXISTS(SELECT 1 FROM lti_operation_reservations WHERE key=?)`;
  const statements=[
   prepare(`INSERT INTO mutation_receipts(token,kind,resource_id) SELECT ?,'lti_material',? WHERE ${auth.sql} AND ${course} AND ${RESOURCE}=? AND ${REFS}=? AND ${VIDEO}=?
    AND ${job()} IS ? AND ${job(true)} IS ? AND NOT(${BUSY}) AND ${priorGuard}`,
    [token,scope.videoId,...auth.values,...courseArgs,...resourceArgs,state.resource,scope.videoId,scope.videoId,state.refs,...videoArgs,state.video,...jobArgs,state.job,...jobArgs,state.retryJob,...jobArgs,...(prior?[id,scope.actorKey,resource.id,requestHash,prior.external_task_id]:[id,key])]),
   prepare(`INSERT INTO lti_operation_reservations(key) SELECT ? WHERE ${gate} ON CONFLICT DO NOTHING`,[key,token]),
  ];
  if(!prior){
   statements.push(prepare(`UPDATE videos SET description=?,transcript=?,status=?,error_message=CASE WHEN ?=1 THEN '' ELSE error_message END WHERE id=? AND ${gate}`,[next.description,next.transcript,next.status,message?1:0,scope.videoId,token]));
   if(indexChanged)statements.push(
    prepare(`INSERT INTO video_index_versions(video_id,revision) SELECT ?,? WHERE ${gate} ON CONFLICT(video_id) DO UPDATE SET revision=excluded.revision`,[scope.videoId,crypto.randomUUID(),token]),
    enqueueCurrentSceneDeletes(database,scope.videoId,token),enqueueStagedSceneDeletes(database,scope.videoId,token),
    prepare(`DELETE FROM scenes WHERE video_id=? AND ${gate}`,[scope.videoId,token]),
    prepare(`DELETE FROM scene_staging WHERE run_id IN(SELECT id FROM scene_index_runs WHERE video_id=?) AND ${gate}`,[scope.videoId,token]));
   if(message)statements.push(prepare(`INSERT INTO external_tasks(kind,payload,dedupe_key) SELECT 'sqs_job',?,? WHERE ${gate}`,[JSON.stringify({message}),dedupeKey,token]));
   statements.push(prepare(`INSERT INTO lti_material_operations(id,resource_id,video_id,course_id,source_generation,actor_key,action,request_hash,before_revision,after_revision,external_task_id)
    SELECT ?,?,?,?,?,?,?,?,?,?,(SELECT id FROM external_tasks WHERE dedupe_key=?) WHERE ${gate}`,[id,resource.id,scope.videoId,scope.courseId,scope.generation,scope.actorKey,input.action,requestHash,beforeRevision,await revisionOf(scope,next),message?dedupeKey:'',token]));
  }
  const output=statements.length;
  statements.push(prepare(`SELECT ${VIDEO} AS video,${job()} AS job,${job(true)} AS retryJob,(SELECT external_task_id FROM lti_material_operations WHERE id=?) AS taskId WHERE ${gate}`,[...videoArgs,...jobArgs,...jobArgs,id,token]),prepare('DELETE FROM mutation_receipts WHERE token=?',[token]));
  const result=await database.batch<Record<string,unknown>>(statements),row=result[output].results[0];
  if(row){const current=decode<ManagedVideo>(row.video)!;return {material:await materialView(scope,current,decode<MaterialJob>(row.job),current.status==='error'?decode<MaterialJob>(row.retryJob):undefined),externalTaskId:row.taskId===null?null:Number(row.taskId),reused:Boolean(prior)};}
 }
 throw conflict('This material was changed by another operation. Refresh before saving.');
 } catch(error) { throw asApiError(error)??error; }
}};}
