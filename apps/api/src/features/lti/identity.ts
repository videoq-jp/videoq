import { digest } from './store';

/** Internal attribution only; never an authentication credential or browser input. */
export type LtiDataSubject = { subjectKey: string; resourceVideoIds: number[] };
export const ltiSubjectKey = (scope: { registrationId: string; subjectHash: string }) =>
  digest(JSON.stringify(['lti-data-subject-v1', scope.registrationId, scope.subjectHash]));

export function checkedLtiSubject(subject: LtiDataSubject): LtiDataSubject {
  if (!/^[a-f0-9]{64}$/.test(subject.subjectKey) || subject.resourceVideoIds.length > 1000
    || subject.resourceVideoIds.some(id => !Number.isSafeInteger(id) || id <= 0)) throw new Error('Invalid LTI subject scope');
  return { subjectKey: subject.subjectKey, resourceVideoIds: [...new Set(subject.resourceVideoIds)].sort((a,b) => a-b) };
}
