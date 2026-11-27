import { checkedLtiSubjectIdentity, type LtiSubjectIdentity } from '../lms/subject-identity';
export type ConversationIdentityScope = { ownerUserId: string; actorUserId: string | null; courseId: number | null; shareSlug: string | null; visitorSessionId?: string; ltiSubject?: LtiSubjectIdentity };

/** Canonical persisted identity; keep existing namespaces and field order stable. */
export function conversationIdentityInput(scope: ConversationIdentityScope, conversationId: string): string {
  if (scope.shareSlug && !scope.visitorSessionId) throw new Error('Shared conversations require a visitor session');
  const subject = scope.ltiSubject ? checkedLtiSubjectIdentity(scope.ltiSubject) : null;
  if (subject && (scope.actorUserId !== null || scope.shareSlug !== null || !Number.isSafeInteger(scope.courseId) || !scope.courseId || scope.courseId <= 0)) {
    throw new Error('Invalid LTI conversation scope');
  }
  return JSON.stringify(subject ? [
    'lti-personal-conversation-v1', scope.ownerUserId, subject.subjectKey, scope.courseId, conversationId,
  ] : [
    scope.ownerUserId, scope.actorUserId, scope.courseId, scope.shareSlug, conversationId,
    ...(scope.shareSlug ? [scope.visitorSessionId] : []),
  ]);
}
