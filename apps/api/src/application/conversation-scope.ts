import { checkLtiDataSubject, type LtiDataSubject } from './subject-identity';

export type ConversationScope = {
  ownerUserId: string; actorUserId: string | null; courseId: number | null; shareSlug: string | null;
  visitorSessionId?: string; ltiSubject?: LtiDataSubject;
};

import { conversationIdentityInput } from '../domain/conversation/scope-identity';
/** Proof validation is an application boundary; persistent identity is domain-owned. */
export function conversationThreadInput(scope: ConversationScope, conversationId: string): string {
  return conversationIdentityInput({ ...scope, ltiSubject: scope.ltiSubject ? checkLtiDataSubject(scope.ltiSubject) : undefined }, conversationId);
}
