import { createLtiSessionProof, type LtiSessionProof } from './lti-session-proof';
import type { PrivacyInstallation, PrivacySubject } from './privacy';

export type LtiDataSubject = { subjectKey: string; resourceVideoIds: number[]; sessionProof?: LtiSessionProof };
const QA_NAMESPACE = 'lti-course-qa-v1';
const HISTORY_NAMESPACE = 'lti-course-history-v1';
type CourseIdentity = { registrationId: string; subjectHash: string; courseId: number };
export const courseQaAuthorInput = (scope: CourseIdentity): string => JSON.stringify([QA_NAMESPACE, scope.registrationId, scope.subjectHash, scope.courseId]);
export const courseHistoryIdentityInput = (scope: CourseIdentity): string => JSON.stringify([HISTORY_NAMESPACE, scope.registrationId, scope.subjectHash, scope.courseId]);
/** PostgreSQL appends its typed numeric course ID before hashing inside SQL. */
export function privacyIdentityPrefixes(scope: Pick<CourseIdentity, 'registrationId' | 'subjectHash'>) {
  return { qa: JSON.stringify([QA_NAMESPACE, scope.registrationId, scope.subjectHash]).slice(0,-1)+',',
    history: JSON.stringify([HISTORY_NAMESPACE, scope.registrationId, scope.subjectHash]).slice(0,-1)+',' };
}
export const ltiSubjectKeyInput = (scope: { registrationId: string; subjectHash: string }): string =>
  JSON.stringify(['lti-data-subject-v1', scope.registrationId, scope.subjectHash]);

export function checkLtiDataSubject(subject: LtiDataSubject): LtiDataSubject {
  if (!/^[a-f0-9]{64}$/.test(subject.subjectKey) || subject.resourceVideoIds.length > 1000
    || subject.resourceVideoIds.some(id => !Number.isSafeInteger(id) || id <= 0)) throw new Error('Invalid LTI subject scope');
  return { subjectKey: subject.subjectKey, resourceVideoIds: [...new Set(subject.resourceVideoIds)].sort((a, b) => a - b),
    ...(subject.sessionProof ? { sessionProof: createLtiSessionProof(subject.sessionProof, subject.sessionProof.sessionHash) } : {}),
  };
}

export async function derivePrivacySubject(installation: PrivacyInstallation, rawSubject: string, digest: (value: string) => Promise<string>): Promise<PrivacySubject> {
  const subjectHash = await digest(JSON.stringify([installation.issuer, installation.clientId, installation.deploymentId, rawSubject]));
  const registrationId = 'db:' + installation.id;
  return { subjectHash, registrationId, subjectKey: await digest(ltiSubjectKeyInput({ registrationId, subjectHash })) };
}
