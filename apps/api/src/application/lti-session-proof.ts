/** Server-derived proof of a stored LMS session. */
export type LtiSessionProof = { sessionHash: string; registrationId: string; subjectHash: string };

import { forbidden } from './errors';

export function createLtiSessionProof(grant: { registrationId: string; subjectHash: string }, sessionHash: string): LtiSessionProof {
  if (!/^[a-f0-9]{64}$/.test(sessionHash) || !/^[a-f0-9]{64}$/.test(grant.subjectHash)) {
    throw forbidden('The Moodle session is unavailable.');
  }
  return { sessionHash, registrationId: grant.registrationId, subjectHash: grant.subjectHash };
}
