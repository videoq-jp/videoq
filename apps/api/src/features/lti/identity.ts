import { digest } from './store';
import { asApiError } from '../../shared/errors';
import { checkLtiDataSubject, ltiSubjectKeyInput } from '../../application/subject-identity';
import type { LtiDataSubject } from '../../application/subject-identity';
export type { LtiDataSubject } from '../../application/subject-identity';

export const ltiSubjectKey = (scope: { registrationId: string; subjectHash: string }) => digest(ltiSubjectKeyInput(scope));
export function checkedLtiSubject(subject: LtiDataSubject): LtiDataSubject {
  try { return checkLtiDataSubject(subject); }
  catch (error) { throw asApiError(error) ?? error; }
}
