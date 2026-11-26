import { isInvitationExpired, type InvitationStatus } from './course-invitations';

export interface InvitationChoice<Predicate, Value> {
  and(left: Predicate, right: Predicate): Predicate;
  when(condition: Predicate, yes: Value, no: Value): Value;
}
export const invitationBooleanChoice = <Value>(): InvitationChoice<boolean, Value> => ({
  and: (left, right) => left && right,
  when: (condition, yes, no) => condition ? yes : no,
});

/** Replay precedes state/expiry/recipient checks, but adapters must first fence
 * current course authority and the invitation itself in their atomic operation. */
export function invitationDecisionState<Predicate, Value>(facts: {
  accepting: Predicate; accepted: Predicate; acceptedByActor: Predicate; notPending: Predicate; expired: Predicate;
}, outcomes: { replay: Value; invalidState: Value; expired: Value; recipient: Value }, logic: InvitationChoice<Predicate, Value>): Value {
  const replay = logic.and(logic.and(facts.accepting, facts.accepted), facts.acceptedByActor);
  return logic.when(replay, outcomes.replay, logic.when(facts.notPending, outcomes.invalidState,
    logic.when(facts.expired, outcomes.expired, outcomes.recipient)));
}

/** Identity changes are a retryable storage snapshot conflict, checked only
 * after verification; email mismatch must not mask either earlier outcome. */
export function invitationRecipientState<Predicate, Value>(facts: {
  unverified: Predicate; identityChanged: Predicate; emailMismatch: Predicate;
}, outcomes: { unverified: Value; retry: Value; mismatch: Value; apply: Value }, logic: InvitationChoice<Predicate, Value>): Value {
  return logic.when(facts.unverified, outcomes.unverified,
    logic.when(facts.identityChanged, outcomes.retry, logic.when(facts.emailMismatch, outcomes.mismatch, outcomes.apply)));
}

export function invitationControlState<Predicate, Value>(facts: { notPending: Predicate; expired: Predicate },
  outcomes: { invalidState: Value; expired: Value; apply: Value }, logic: InvitationChoice<Predicate, Value>): Value {
  return logic.when(facts.notPending, outcomes.invalidState, logic.when(facts.expired, outcomes.expired, outcomes.apply));
}

export function invitationDecisionEffects(action: 'accept' | 'decline'): {
  status: 'accepted' | 'declined'; addMembership: boolean; requiresNative: boolean;
} {
  return action === 'accept' ? { status: 'accepted', addMembership: true, requiresNative: true }
    : { status: 'declined', addMembership: false, requiresNative: false };
}

export function invitationControlEffects(action: 'resend' | 'revoke'): { rotateToken: boolean; requiresNative: boolean } {
  return { rotateToken: action === 'resend', requiresNative: action === 'resend' };
}

export function planInvitationControl(status: InvitationStatus, expiresAt: Date, now: Date):
  { kind: 'apply' } | { kind: 'deny'; status: InvitationStatus; markExpired: boolean } {
  const outcome = invitationControlState({ notPending: status !== 'pending', expired: isInvitationExpired(expiresAt, now) },
    { invalidState: 'state', expired: 'expired', apply: 'apply' } as const, invitationBooleanChoice<'state' | 'expired' | 'apply'>());
  return outcome === 'apply' ? { kind: 'apply' }
    : { kind: 'deny', status: outcome === 'expired' ? 'expired' : status, markExpired: outcome === 'expired' };
}

/** A persisted invitation is an entity, identified independently of its token.
 * Restore only after the adapter has fenced current course authority and locked
 * the invitation. Acceptance and its membership must commit together.
 */
export type CourseInvitation = Readonly<{
  id: number;
  courseId: number;
  status: InvitationStatus;
  expiresAt: string;
  acceptedByUserId: string | null;
}>;

export type InvitationDecision =
  | { kind: 'replay'; courseId: number }
  | { kind: 'invalidState'; status: InvitationStatus }
  | { kind: 'expired' }
  | { kind: 'verifyRecipient'; effects: ReturnType<typeof invitationDecisionEffects> };

/** Decide from a transaction-consistent snapshot, without fetching or mutating it.
 * SQL backends use the same decision algebra inside conditional writes.
 */
export function decideCourseInvitation(invitation: CourseInvitation, action: 'accept' | 'decline',
  actorId: string, now: Date): InvitationDecision {
  const state = invitationDecisionState({
    accepting: action === 'accept', accepted: invitation.status === 'accepted',
    acceptedByActor: invitation.acceptedByUserId === actorId,
    notPending: invitation.status !== 'pending',
    expired: isInvitationExpired(new Date(invitation.expiresAt), now),
  }, { replay: 'replay', invalidState: 'state', expired: 'expired', recipient: 'recipient' } as const,
  invitationBooleanChoice<'replay' | 'state' | 'expired' | 'recipient'>());
  if (state === 'replay') return { kind: 'replay', courseId: invitation.courseId };
  if (state === 'state') return { kind: 'invalidState', status: invitation.status };
  if (state === 'expired') return { kind: 'expired' };
  return { kind: 'verifyRecipient', effects: invitationDecisionEffects(action) };
}
