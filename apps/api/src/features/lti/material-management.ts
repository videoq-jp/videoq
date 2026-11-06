import { z } from 'zod';
import { sql } from 'drizzle-orm';
import { withDb, type Db } from '../../db/pool';
import { ltiMaterialOperations } from '../../db/schema';
import { lockLmsGrant } from '../../repositories/lms-resource-repository';
import { insertJobTask } from '../../repositories/external-task-repository';
import { buildJobMessage, type JobMessage } from '../../lib/job-message';
import { validateTranscriptSrt } from '../../lib/srt';
import { ApiError, apiNotFound } from '../../shared/errors';
import { digest } from './store';
import type { Bindings } from '../../types/bindings';
import type pg from 'pg';
import { lockLtiDataSessionWithDb, type LtiSessionProof } from './data-lock';

const identity = { videoId: z.number().int().positive().safe() };
const mutation = { ...identity, operationId: z.uuid(), revision: z.string().regex(/^[a-f0-9]{64}$/) };
export const materialManagementInput = z.discriminatedUnion('action', [
  z.object({ action: z.literal('get'), ...identity }).strict(),
  z.object({ action: z.literal('update'), ...mutation,
    fields: z.object({ description: z.string().max(20000).optional(), transcript: z.string().max(2*1024*1024).optional() })
      .strict().refine(fields => Object.keys(fields).length > 0),
  }).strict(),
  z.object({ action: z.literal('reindex'), ...mutation }).strict(),
  z.object({ action: z.literal('retry'), ...mutation }).strict(),
]);
export type ManagedMaterialScope = {
  installationId: string; ownerUserId: string; courseId: number; contextId: string;
  resourceLinkId: string; videoId: number; generation: number; actorKey: string;
  sessionProof?: LtiSessionProof;
};
type Video = { title: string; description: string | null; transcript: string | null; status: string; file: string };
type Job = { id: string; message: unknown; dead: boolean; status: string | null };
const conflict = (message: string) => new ApiError(409, 'CONFLICT', message);
const revisionOf = (scope: ManagedMaterialScope, video: Video) => digest(JSON.stringify([
  'lti-material-v1', scope.installationId, scope.videoId, scope.generation, video.title, video.description, video.transcript, video.status, video.file,
]));
const originalMessage = z.object({ type: z.literal('transcribe_video'), job_id: z.string().min(1).max(128),
  payload: z.object({ video_id: z.number().int().positive().safe() }).strict() }).strict();

async function readVideo(client: pg.Client, scope: ManagedMaterialScope): Promise<Video> {
  const video = (await client.query<Video>(`SELECT title,file,status,
    CASE WHEN octet_length(description)<=40000 THEN description END AS description,
    CASE WHEN octet_length(transcript)<=2097152 THEN transcript END AS transcript
    FROM videos WHERE id=$1 AND user_id=$2 AND managed_by_lms=true FOR UPDATE`, [scope.videoId, scope.ownerUserId])).rows[0];
  if (!video) throw apiNotFound('Material not found.');
  if (video.description === null || video.transcript === null) throw new ApiError(413, 'VALIDATION_ERROR', 'This material is too large to edit here.');
  return video;
}
async function latestJob(client: pg.Client, videoId: number, transcribeOnly = false) {
  return (await client.query<Job>(`SELECT e.id,e.payload->'message' AS message,e.dead_at IS NOT NULL AS dead,j.status
    FROM external_tasks e LEFT JOIN job_executions j ON j.job_id=e.payload->'message'->>'job_id'
    WHERE e.kind='sqs_job' AND e.payload->'message'->'payload'->>'video_id'=$1
      AND e.payload->'message'->>'type'=ANY($2::text[]) ORDER BY e.created_at DESC,e.id DESC LIMIT 1`,
  [String(videoId), transcribeOnly ? ['transcribe_video'] : ['transcribe_video','index_video_transcript','reindex_video_transcript']])).rows[0];
}
async function publicMaterial(client: pg.Client, scope: ManagedMaterialScope, video: Video) {
  const job = await latestJob(client, scope.videoId);
  const retryJob = video.status==='error' ? await latestJob(client,scope.videoId,true) : undefined;
  return { videoId: scope.videoId, title: video.title, description: video.description!, transcript: video.transcript!,
    status: video.status, revision: await revisionOf(scope, video),
    canEdit: ['completed','error'].includes(video.status), canReindex: video.status==='completed',
    canRetry: video.status==='indexing' || (video.status==='error' && retryJob?.status!=='completed'
      && originalMessage.safeParse(retryJob?.message).success),
    jobState: job?.dead || job?.status==='failed' ? 'failed' : job?.status==='running' ? 'running' :
      video.status==='completed' ? 'completed' : 'queued' };
}

/** Only the fresh LTI authorization layer may construct this scope. */
export async function manageLtiMaterial(env: Bindings, scope: ManagedMaterialScope, input: z.infer<typeof materialManagementInput>) {
  if (!/^[a-f0-9]{64}$/.test(scope.actorKey) || input.videoId !== scope.videoId) throw apiNotFound('Material not found.');
  if (input.action==='update') {
    if (input.fields.description !== undefined && new TextEncoder().encode(input.fields.description).byteLength>40000)
      throw new ApiError(413,'VALIDATION_ERROR','Description is too large.');
    if (input.fields.transcript !== undefined) {
      if (new TextEncoder().encode(input.fields.transcript).byteLength>2097152) throw new ApiError(413,'VALIDATION_ERROR','Transcript is too large.');
      const error = validateTranscriptSrt(input.fields.transcript);
      if (error) throw new ApiError(400,'VALIDATION_ERROR',error);
    }
  }
  return withDb(env, async (db, client) => {
    await client.query('BEGIN');
    try {
      await lockLmsGrant(db, { id: scope.installationId, ownerUserId: scope.ownerUserId });
      await lockLtiDataSessionWithDb(db,scope.ownerUserId,scope.sessionProof);
      const resource = (await client.query<{ id: string; generation: string }>(`SELECT id,generation FROM lms_resources
        WHERE installation_id=$1 AND context_id=$2 AND resource_link_id=$3 AND course_id=$4 AND video_id=$5 AND enabled=true FOR UPDATE`,
      [scope.installationId,scope.contextId,scope.resourceLinkId,scope.courseId,scope.videoId])).rows[0];
      if (!resource) throw apiNotFound('Material not found.');
      if (Number(resource.generation)!==scope.generation) throw conflict('The Moodle source has changed. Refresh after synchronization.');
      const course = await client.query(`SELECT id FROM video_courses WHERE id=$1 AND user_id=$2 AND managed_by_lms=true FOR SHARE`, [scope.courseId,scope.ownerUserId]);
      if (!course.rowCount) throw apiNotFound('Material not found.');
      const members = await client.query<{ course_id: string }>('SELECT course_id FROM video_course_members WHERE video_id=$1 FOR SHARE', [scope.videoId]);
      const bindings = await client.query('SELECT id FROM lms_resources WHERE video_id=$1 FOR SHARE', [scope.videoId]);
      if (members.rowCount!==1 || Number(members.rows[0].course_id)!==scope.courseId || bindings.rowCount!==1)
        throw conflict('This material is referenced outside this course. Ask the connected account owner to review it.');
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
      const prior = (await client.query<{ actor_key: string; resource_id: string; request_hash: string; external_task_id: string | null }>(
        'SELECT actor_key,resource_id,request_hash,external_task_id FROM lti_material_operations WHERE id=$1', [input.operationId])).rows[0];
      if (prior) {
        if (prior.actor_key!==scope.actorKey || prior.resource_id!==resource.id || prior.request_hash!==requestHash)
          throw conflict('This operation identifier has already been used.');
        const material = await publicMaterial(client,scope,video); await client.query('COMMIT');
        return { material, externalTaskId: prior.external_task_id === null ? null : Number(prior.external_task_id), reused: true };
      }
      const beforeRevision = await revisionOf(scope,video);
      if (beforeRevision!==input.revision) throw conflict('This material was changed by another operation. Refresh before saving.');
      let message: JobMessage | undefined;
      if (input.action==='update') {
        if (!['completed','error'].includes(video.status)) throw conflict('Wait for processing before editing this material.');
        const transcriptChanged = input.fields.transcript !== undefined && input.fields.transcript!==video.transcript;
        await updateDerivedFields(db,scope.videoId,input.fields,transcriptChanged);
        if (transcriptChanged) message=buildJobMessage('index_video_transcript',{video_id:scope.videoId,
          ...(!input.fields.transcript!.trim() ? {allow_empty:true} : {})});
      } else if (input.action==='reindex' || video.status==='indexing') {
        if (input.action==='reindex' && video.status!=='completed') throw conflict('Wait for processing before starting a new index.');
        await client.query("UPDATE videos SET status='indexing',error_message='' WHERE id=$1",[scope.videoId]);
        message=buildJobMessage('index_video_transcript',{video_id:scope.videoId,...(!video.transcript?.trim()?{allow_empty:true}:{})});
      } else {
        if (video.status!=='error') throw conflict('This material does not need a processing retry.');
        const retryJob=await latestJob(client,scope.videoId,true);
        const original=originalMessage.safeParse(retryJob?.message);
        if (!original.success || original.data.payload.video_id!==scope.videoId || retryJob?.status==='completed')
          throw conflict('Retry synchronization from Moodle for this processing job.');
        // Reuse the original job identity/payload, preserving worker leases and
        // usage receipts even when its automatic retry is still in the queue.
        message=original.data;
        await client.query("UPDATE videos SET status='pending',error_message='' WHERE id=$1",[scope.videoId]);
      }
      const task=message ? await insertJobTask(db,{message,dedupeKey:'lti-material:'+input.operationId}) : null;
      const next = await readVideo(client,scope);
      await db.insert(ltiMaterialOperations).values({ id:input.operationId,resourceId:resource.id,videoId:scope.videoId,
        courseId:scope.courseId,sourceGeneration:scope.generation,actorKey:scope.actorKey,action:input.action,requestHash,
        beforeRevision,afterRevision:await revisionOf(scope,next),externalTaskId:task?.id??null });
      const material=await publicMaterial(client,scope,next); await client.query('COMMIT');
      return { material, externalTaskId:task?.id??null, reused:false };
    } catch(error) { await client.query('ROLLBACK'); throw error; }
  });
}

async function updateDerivedFields(db: Db, videoId: number,
  fields: {description?:string;transcript?:string}, transcriptChanged:boolean) {
  // Title, source identity and source media are canonical Moodle fields.
  await db.execute(sql`UPDATE videos SET
    description=CASE WHEN ${fields.description!==undefined} THEN ${fields.description??''} ELSE description END,
    transcript=CASE WHEN ${fields.transcript!==undefined} THEN ${fields.transcript??''} ELSE transcript END,
    status=CASE WHEN ${transcriptChanged} THEN 'indexing' ELSE status END,
    error_message=CASE WHEN ${transcriptChanged} THEN '' ELSE error_message END WHERE id=${videoId}`);
}
