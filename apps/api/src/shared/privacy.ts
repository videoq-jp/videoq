import { assertPrivacyRecovery as checkRecovery } from '../application/privacy-policy';
import { asApiError } from './errors';
import {z} from 'zod';
import {lmsIdentity} from '../features/lms/contracts';
import {digest} from '../features/lti/store';
import { derivePrivacySubject } from '../application/subject-identity';
import { privacyCollections } from '../application/privacy';
import type { PrivacyInstallation, PrivacySubject } from '../application/privacy';
export { ORPHAN_CONTEXT, privacyCollections } from '../application/privacy';
export type { PrivacyInstallation, PrivacySubject } from '../application/privacy';
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
export function privacySubject(installation:PrivacyInstallation,rawSubject:string):Promise<PrivacySubject> {
  return derivePrivacySubject(installation, rawSubject, digest);
}

export function assertPrivacyRecovery(allowed: boolean, upgraded = true): void {
  try { checkRecovery(allowed,upgraded); }
  catch(error) { throw asApiError(error)??error; }
}
