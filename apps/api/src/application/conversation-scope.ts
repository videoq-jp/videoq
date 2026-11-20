import { checkLtiDataSubject, type LtiDataSubject } from './subject-identity';

export type ConversationScope = {
  ownerUserId: string; actorUserId: string | null; courseId: number | null; shareSlug: string | null;
  visitorSessionId?: string; ltiSubject?: LtiDataSubject;
};

/** Canonical persisted identity; keep existing namespaces and field order stable. */
export function conversationThreadInput(scope: ConversationScope, conversationId: string): string {
  if (scope.shareSlug && !scope.visitorSessionId) throw new Error('Shared conversations require a visitor session');
  const subject = scope.ltiSubject ? checkLtiDataSubject(scope.ltiSubject) : null;
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
