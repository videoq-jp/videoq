import { assertMaterialGeneration, assertMaterialReferences, assertMaterialReadable, assertMaterialReplayIdentity, assertMaterialOperationAvailable, assertMaterialRevision, materialMutationKind, planMaterialMutation } from '../../application/material-mutation';
import { inlineTranscript, inlineMaterialDescription } from '../../application/content-read';
import { contentStringLogic } from '../content-read-policy-sql';
import type pg from 'pg';
import {sql} from 'drizzle-orm';
import {withDb,type Db} from '../../db/pool';
import {ltiMaterialOperations} from '../../db/schema';
import {lockLmsGrant} from './lms-resource-repository';
import {lockLtiDataSessionWithDb} from './lti-session-lock';
import {reserveLtiOperation} from './operation-reservations';
import {insertJobTask} from './external-task-repository';
import {buildJobMessage,type JobMessage} from '../../lib/job-message';
import {apiNotFound,asApiError} from '../../shared/errors';
import type { ReadableManagedVideo } from '../../application/material-management';
import {digest} from '../../features/lti/store';
import {materialConflict as conflict,revisionOf,originalMessage,materialView,checkMaterialManagement} from '../../shared/material-management';
import type {Bindings} from '../../types/bindings';
import type {ManagedMaterialScope,ManagedVideo,MaterialJob,MaterialManagementRepository} from '../contracts/material-management-repository';
async function readVideo(client: pg.Client, scope: ManagedMaterialScope): Promise<ReadableManagedVideo> {
  const video = (await client.query<ManagedVideo>(`SELECT title,file,status,
    ${inlineMaterialDescription('description','octet_length(description)',contentStringLogic)} AS description,
    ${inlineTranscript('transcript','octet_length(transcript)',contentStringLogic).value} AS transcript
    FROM videos WHERE id=$1 AND user_id=$2 AND managed_by_lms=true FOR UPDATE`, [scope.videoId, scope.ownerUserId])).rows[0];
  if (!video) throw apiNotFound('Material not found.');
  assertMaterialReadable(video);
  return video;
}
async function latestJob(client: pg.Client, videoId: number, transcribeOnly = false) {
  return (await client.query<MaterialJob>(`SELECT e.id,e.payload->'message' AS message,e.dead_at IS NOT NULL AS dead,j.status
    FROM external_tasks e LEFT JOIN job_executions j ON j.job_id=e.payload->'message'->>'job_id'
    WHERE e.kind='sqs_job' AND e.payload->'message'->'payload'->>'video_id'=$1
      AND e.payload->'message'->>'type'=ANY($2::text[]) ORDER BY e.created_at DESC,e.id DESC LIMIT 1`,
  [String(videoId), transcribeOnly ? ['transcribe_video'] : ['transcribe_video','index_video_transcript','reindex_video_transcript']])).rows[0];
}
async function publicMaterial(client: pg.Client, scope: ManagedMaterialScope, video: ManagedVideo) {
  const job = await latestJob(client, scope.videoId);
  const retryJob = video.status==='error' ? await latestJob(client,scope.videoId,true) : undefined;
  return materialView(scope,video,job,retryJob);
}

export function createPostgresMaterialManagementRepository(env:Bindings):MaterialManagementRepository{return {async execute(scope,input){
 checkMaterialManagement(scope,input);
  return withDb(env, async (db, client) => {
    await client.query('BEGIN');
    try {
      await lockLmsGrant(db, { id: scope.installationId, ownerUserId: scope.ownerUserId },scope.contextId,scope.courseId);
      await lockLtiDataSessionWithDb(db,scope.ownerUserId,scope.sessionProof);
      const resource = (await client.query<{ id: string; generation: string }>(`SELECT id,generation FROM lms_resources
        WHERE installation_id=$1 AND context_id=$2 AND resource_link_id=$3 AND course_id=$4 AND video_id=$5 AND enabled=true FOR UPDATE`,
      [scope.installationId,scope.contextId,scope.resourceLinkId,scope.courseId,scope.videoId])).rows[0];
      if (!resource) throw apiNotFound('Material not found.');
      assertMaterialGeneration(Number(resource.generation),scope.generation);
      const course = await client.query(`SELECT id FROM video_courses WHERE id=$1 AND user_id=$2 AND managed_by_lms=true FOR SHARE`, [scope.courseId,scope.ownerUserId]);
      if (!course.rowCount) throw apiNotFound('Material not found.');
      const members = await client.query<{ course_id: string }>('SELECT course_id FROM video_course_members WHERE video_id=$1 FOR SHARE', [scope.videoId]);
      const bindings = await client.query('SELECT id FROM lms_resources WHERE video_id=$1 FOR SHARE', [scope.videoId]);
      assertMaterialReferences(members.rowCount??0,Number(members.rows[0]?.course_id),bindings.rowCount??0,scope.courseId);
      if (input.action!=='get') {
        // Match the Python indexer's global/shared and per-video locks. Never
        // wait for provider I/O while holding course/account row locks.
        if (!(await client.query<{ ok: boolean }>('SELECT pg_try_advisory_xact_lock_shared($1::bigint) AS ok', [0x564944454F51])).rows[0].ok
          || !(await client.query<{ ok: boolean }>('SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS ok', ['videoq:vector:video:'+scope.videoId])).rows[0].ok)
          throw conflict('This material is being indexed. Try again after processing finishes.');
      }
      const video = await readVideo(client, scope);
      if (input.action==='get') {
        const material = await publicMaterial(client,scope,video); await client.query('COMMIT');
        return { material, externalTaskId: null, reused: false };
      }
      const requestHash = await digest(JSON.stringify(input));
      const freshOperation = await reserveLtiOperation(client, 'material', input.operationId);
      const prior = (await client.query<{ actor_key: string; resource_id: string; request_hash: string; external_task_id: string | null }>(
        'SELECT actor_key,resource_id,request_hash,external_task_id FROM lti_material_operations WHERE id=$1', [input.operationId])).rows[0];
      if (prior) {
        assertMaterialReplayIdentity(prior.actor_key===scope.actorKey,prior.resource_id===resource.id,prior.request_hash===requestHash);
        const material = await publicMaterial(client,scope,video); await client.query('COMMIT');
        return { material, externalTaskId: prior.external_task_id === null ? null : Number(prior.external_task_id), reused: true };
      }
      assertMaterialOperationAvailable(freshOperation);
      const beforeRevision = await revisionOf(scope,video);
      assertMaterialRevision(beforeRevision,input.revision);
      const kind=materialMutationKind(input,video.status);
      const retryJob=kind==='retry'?await latestJob(client,scope.videoId,true):undefined;
      const original=kind==='retry'?originalMessage.safeParse(retryJob?.message):undefined;
      const plan=planMaterialMutation(input,video,original?.success?original.data:undefined,retryJob?.status);
      let message: JobMessage | undefined;
      if(input.action==='update') await updateDerivedFields(db,scope.videoId,input.fields,plan.transcriptChanged);
      else await client.query("UPDATE videos SET status=$1,error_message='' WHERE id=$2",[plan.next.status,scope.videoId]);
      if(plan.job) message=plan.job.kind==='index'?buildJobMessage('index_video_transcript',plan.job.payload):plan.job.message;
      const task=message ? await insertJobTask(db,{message,dedupeKey:'lti-material:'+input.operationId}) : null;
      const next = await readVideo(client,scope);
      await db.insert(ltiMaterialOperations).values({ id:input.operationId,resourceId:resource.id,videoId:scope.videoId,
        courseId:scope.courseId,sourceGeneration:scope.generation,actorKey:scope.actorKey,action:input.action,requestHash,
        beforeRevision,afterRevision:await revisionOf(scope,next),externalTaskId:task?.id??null });
      const material=await publicMaterial(client,scope,next); await client.query('COMMIT');
      return { material, externalTaskId:task?.id??null, reused:false };
    } catch(error) { await client.query('ROLLBACK'); throw asApiError(error)??error; }
  });
}};}

async function updateDerivedFields(db: Db, videoId: number,
  fields: {description?:string;transcript?:string}, transcriptChanged:boolean) {
  // Title, source identity and source media are canonical Moodle fields.
  await db.execute(sql`UPDATE videos SET
    description=CASE WHEN ${fields.description!==undefined} THEN ${fields.description??''} ELSE description END,
    transcript=CASE WHEN ${fields.transcript!==undefined} THEN ${fields.transcript??''} ELSE transcript END,
    status=CASE WHEN ${transcriptChanged} THEN 'indexing' ELSE status END,
    error_message=CASE WHEN ${transcriptChanged} THEN '' ELSE error_message END WHERE id=${videoId}`);
}
