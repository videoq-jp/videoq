import {z} from 'zod';
import {ApiError,apiNotFound} from './errors';
import {validateTranscriptSrt} from '../lib/srt';
import {digest} from '../features/lti/store';
import {ltiSessionProof} from './lti-session-proof';
import type {ManagedMaterialScope,ManagedVideo,MaterialJob} from '../persistence/contracts/material-management-repository';
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
export const materialConflict = (message: string) => new ApiError(409, 'CONFLICT', message);
export const revisionOf = (scope: ManagedMaterialScope, video: ManagedVideo) => digest(JSON.stringify([
  'lti-material-v1', scope.installationId, scope.videoId, scope.generation, video.title, video.description, video.transcript, video.status, video.file,
]));
export const originalMessage = z.object({ type: z.literal('transcribe_video'), job_id: z.string().min(1).max(128),
  payload: z.object({ video_id: z.number().int().positive().safe() }).strict() }).strict();

export async function materialView(scope:ManagedMaterialScope,video:ManagedVideo,job:MaterialJob|undefined,retryJob:MaterialJob|undefined){
  return { videoId: scope.videoId, title: video.title, description: video.description!, transcript: video.transcript!,
    status: video.status, revision: await revisionOf(scope, video),
    canEdit: ['completed','error'].includes(video.status), canReindex: video.status==='completed',
    canRetry: video.status==='indexing' || (video.status==='error' && retryJob?.status!=='completed'
      && originalMessage.safeParse(retryJob?.message).success),
    jobState: job?.dead || job?.status==='failed' ? 'failed' : job?.status==='running' ? 'running' :
      video.status==='completed' ? 'completed' : 'queued' };
}
export function checkMaterialManagement(scope:ManagedMaterialScope,input:z.infer<typeof materialManagementInput>):void{
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
 if(scope.sessionProof){ltiSessionProof(scope.sessionProof,scope.sessionProof.sessionHash);if(scope.sessionProof.registrationId!=='db:'+scope.installationId)throw apiNotFound('Material not found.');}
}
