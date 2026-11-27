import { textValueSchema } from '@videoq/trpc/text-value';
import {z} from 'zod';
import { asApiError } from './errors';
import * as policy from '../features/material-management/policy';
import {validateTranscriptSrt} from '../lib/srt';
import {digest} from '../features/lti/store';
import type {ManagedMaterialScope,ManagedVideo,MaterialJob} from '../persistence/contracts/material-management-repository';
const identity = { videoId: z.number().int().positive().safe() };
const mutation = { ...identity, operationId: z.uuid(), revision: z.string().regex(/^[a-f0-9]{64}$/) };
export const materialManagementInput = z.discriminatedUnion('action', [
  z.object({ action: z.literal('get'), ...identity }).strict(),
  z.object({ action: z.literal('update'), ...mutation,
    fields: z.object({ description: textValueSchema.max(20000).optional(), transcript: textValueSchema.max(2*1024*1024).optional() })
      .strict().refine(fields => Object.keys(fields).length > 0),
  }).strict(),
  z.object({ action: z.literal('reindex'), ...mutation }).strict(),
  z.object({ action: z.literal('retry'), ...mutation }).strict(),
]);
export const originalMessage = z.object({ type: z.literal('transcribe_video'), job_id: z.string().min(1).max(128),
  payload: z.object({ video_id: z.number().int().positive().safe() }).strict() }).strict();

const dependencies: policy.MaterialPolicyDependencies = {
  digest, byteLength: value => new TextEncoder().encode(value).byteLength,
  validateTranscript: validateTranscriptSrt,
  validTranscriptionMessage: value => originalMessage.safeParse(value).success,
};
export const materialConflict = (message: string) => asApiError(policy.materialConflict(message))!;
export const revisionOf = (scope: ManagedMaterialScope, video: ManagedVideo) => policy.revisionOf(scope, video, digest);
export function materialView(scope: ManagedMaterialScope, video: ManagedVideo, job: MaterialJob | undefined, retryJob: MaterialJob | undefined) {
  return policy.materialView(scope, video, job, retryJob, dependencies);
}
export function checkMaterialManagement(scope: ManagedMaterialScope, input: z.infer<typeof materialManagementInput>) {
  try { return policy.checkMaterialManagement(scope, input, dependencies); }
  catch (error) { throw asApiError(error) ?? error; }
}
