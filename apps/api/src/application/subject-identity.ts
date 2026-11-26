import { createLtiSessionProof, type LtiSessionProof } from './lti-session-proof';
import type { PrivacyInstallation, PrivacySubject } from '../domain/lms/privacy';

export type LtiDataSubject = { subjectKey: string; resourceVideoIds: number[]; sessionProof?: LtiSessionProof };
export { courseQaAuthorInput, courseHistoryIdentityInput, privacyIdentityPrefixes, ltiSubjectKeyInput } from '../domain/lms/subject-identity';
import { checkedLtiSubjectIdentity, ltiSubjectKeyInput } from '../domain/lms/subject-identity';

export function checkLtiDataSubject(subject: LtiDataSubject): LtiDataSubject {
  return { ...checkedLtiSubjectIdentity(subject),
    ...(subject.sessionProof ? { sessionProof: createLtiSessionProof(subject.sessionProof, subject.sessionProof.sessionHash) } : {}),
  };
}

export async function derivePrivacySubject(installation: PrivacyInstallation, rawSubject: string, digest: (value: string) => Promise<string>): Promise<PrivacySubject> {
  const subjectHash = await digest(JSON.stringify([installation.issuer, installation.clientId, installation.deploymentId, rawSubject]));
  const registrationId = 'db:' + installation.id;
  return { subjectHash, registrationId, subjectKey: await digest(ltiSubjectKeyInput({ registrationId, subjectHash })) };
}
