import { MAX_INLINE_TRANSCRIPT_BYTES, MAX_MATERIAL_DESCRIPTION_BYTES } from '../../application/content-read';
import { conflict, notFound, tooLarge, validationFailure } from '../../application/errors';
import { createLtiSessionProof } from '../../application/lti-session-proof';
import type { MaterialCommand, ManagedMaterialScope, ManagedVideo, MaterialJob } from '../../application/material-management';

export interface MaterialPolicyDependencies {
  digest(value: string): Promise<string>;
  byteLength(value: string): number;
  validateTranscript(value: string): string | null;
  validTranscriptionMessage(value: unknown): boolean;
}

export const materialConflict = (message: string) => conflict(message);
export const revisionOf = (scope: ManagedMaterialScope, video: ManagedVideo, digest: (value: string) => Promise<string>) => digest(JSON.stringify([
  'lti-material-v1', scope.installationId, scope.videoId, scope.generation, video.title, video.description, video.transcript, video.status, video.file,
]));
export async function materialView(scope:ManagedMaterialScope,video:ManagedVideo,job:MaterialJob|undefined,retryJob:MaterialJob|undefined,deps:MaterialPolicyDependencies){
  return { videoId: scope.videoId, title: video.title, description: video.description!, transcript: video.transcript!,
    status: video.status, revision: await revisionOf(scope, video, value => deps.digest(value)),
    canEdit: ['completed','error'].includes(video.status), canReindex: video.status==='completed',
    canRetry: video.status==='indexing' || (video.status==='error' && retryJob?.status!=='completed'
      && deps.validTranscriptionMessage(retryJob?.message)),
    jobState: job?.dead || job?.status==='failed' ? 'failed' : job?.status==='running' ? 'running' :
      video.status==='completed' ? 'completed' : 'queued' };
}
export function checkMaterialManagement(scope:ManagedMaterialScope,input:MaterialCommand,deps:MaterialPolicyDependencies):void{
  if (!/^[a-f0-9]{64}$/.test(scope.actorKey) || input.videoId !== scope.videoId) throw notFound('Material not found.');
  if (input.action==='update') {
    if (input.fields.description !== undefined && deps.byteLength(input.fields.description)>MAX_MATERIAL_DESCRIPTION_BYTES)
      throw tooLarge('Description is too large.');
    if (input.fields.transcript !== undefined) {
      if (deps.byteLength(input.fields.transcript)>MAX_INLINE_TRANSCRIPT_BYTES) throw tooLarge('Transcript is too large.');
      const error = deps.validateTranscript(input.fields.transcript);
      if (error) throw validationFailure(error);
    }
  }
 if(scope.sessionProof){createLtiSessionProof(scope.sessionProof,scope.sessionProof.sessionHash);if(scope.sessionProof.registrationId!=='db:'+scope.installationId)throw notFound('Material not found.');}
}
