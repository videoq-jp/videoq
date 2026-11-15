import {z} from 'zod';
import {lmsIdentity} from '../features/lms/contracts';
import {digest} from '../features/lti/store';
import {ltiSubjectKey} from '../features/lti/identity';
export const ORPHAN_CONTEXT = '@orphan';
export const privacyCollections = ['logs','evaluations','conversations','turns','questions','replies','votes','moderation',
  'material_operations','tag_operations','report_accesses','recent_history','checkpoints','checkpoint_blobs','checkpoint_writes'] as const;
const subject = lmsIdentity;
const contexts = z.array(lmsIdentity).min(1).max(100).refine(ids => new Set(ids).size === ids.length);
const cursor = z.object({ after:z.string().min(1).max(2048).optional(),
  record:z.object({id:z.string().min(1).max(2048),offset:z.number().int().positive().max(2147483647),revision:z.string().regex(/^[a-f0-9]{64}$/)}).strict().optional(),
}).strict().refine(value => !(value.after && value.record));
export const privacyRequest = z.discriminatedUnion('action',[
  z.object({action:z.literal('catalog'),after:z.string().max(255).optional()}).strict(),
  z.object({action:z.literal('contexts'),subject,after:z.string().max(255).optional()}).strict(),
  z.object({action:z.literal('users'),subjects:z.array(subject).min(1).max(100).refine(ids=>new Set(ids).size===ids.length),contexts}).strict(),
  z.object({action:z.literal('export'),subject,contexts,collection:z.enum(privacyCollections),cursor:cursor.optional()}).strict(),
  z.object({action:z.literal('erase'),subject,contexts}).strict(),
]);
export type PrivacyInstallation = {id:string;ownerUserId:string;issuer:string;clientId:string;deploymentId:string;jwksUrl?:string};
export type PrivacySubject = {subjectKey:string;subjectHash:string;registrationId:string};
export async function privacySubject(installation:PrivacyInstallation,rawSubject:string):Promise<PrivacySubject> {
  const subjectHash=await digest(JSON.stringify([installation.issuer,installation.clientId,installation.deploymentId,rawSubject]));
  const registrationId='db:'+installation.id;
  return {subjectHash,registrationId,subjectKey:await ltiSubjectKey({registrationId,subjectHash})};
}
