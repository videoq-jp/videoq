import {checkedLtiSubject} from "../features/lti/identity";
import type {ConversationScope} from "../persistence/contracts/conversation";
export async function conversationThreadId(scope: ConversationScope, conversationId: string): Promise<string> {
  if (scope.shareSlug && !scope.visitorSessionId) throw new Error('Shared conversations require a visitor session');
  const subject = scope.ltiSubject ? checkedLtiSubject(scope.ltiSubject) : null;
  if (subject && (scope.actorUserId !== null || scope.shareSlug !== null || !Number.isSafeInteger(scope.courseId) || !scope.courseId || scope.courseId <= 0)) {
    throw new Error('Invalid LTI conversation scope');
  }
  const bytes = new TextEncoder().encode(JSON.stringify(subject ? [
    'lti-personal-conversation-v1', scope.ownerUserId, subject.subjectKey, scope.courseId, conversationId,
  ] : [
    scope.ownerUserId, scope.actorUserId, scope.courseId, scope.shareSlug, conversationId,
    ...(scope.shareSlug ? [scope.visitorSessionId] : []),
  ]));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

