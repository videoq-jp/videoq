import {ApiError} from './errors';

/** Server-derived proof of the current stored LTI session, never browser input. */
export type LtiSessionProof = { sessionHash: string; registrationId: string; subjectHash: string };
export function ltiSessionProof(grant: { registrationId: string; subjectHash: string }, sessionHash: string): LtiSessionProof {
  if (!/^[a-f0-9]{64}$/.test(sessionHash) || !/^[a-f0-9]{64}$/.test(grant.subjectHash))
    throw new ApiError(403, 'FORBIDDEN', 'The Moodle session is unavailable.');
  return { sessionHash, registrationId: grant.registrationId, subjectHash: grant.subjectHash };
}

