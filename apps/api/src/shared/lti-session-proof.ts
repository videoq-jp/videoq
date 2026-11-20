import { createLtiSessionProof } from '../application/lti-session-proof';
import { asApiError } from './errors';
export type { LtiSessionProof } from '../application/lti-session-proof';

/** Compatibility adapter for existing HTTP-facing persistence and LMS callers. */
export function ltiSessionProof(grant: { registrationId: string; subjectHash: string }, sessionHash: string) {
  try { return createLtiSessionProof(grant, sessionHash); }
  catch (error) { throw asApiError(error) ?? error; }
}
