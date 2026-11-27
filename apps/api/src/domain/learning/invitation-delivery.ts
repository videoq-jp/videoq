import type { InvitationChoice } from './invitation-lifecycle';

export function invitationDeliveryCutoff(now: Date, graceMs: number): Date {
  return new Date(now.getTime() - graceMs);
}

export function invitationDeliveryStranded<T>(facts: { pending: T; queued: T; graceElapsed: T; noLiveTask: T },
  logic: { and(left: T, right: T): T }): T {
  return logic.and(logic.and(logic.and(facts.pending, facts.queued), facts.graceElapsed), facts.noLiveTask);
}

/** Keep expired and live as separate facts: an unknown SQL expiry is neither.
 * In particular, an unparseable D1 expiry must not rotate the stored hash. */
export function invitationDeliveryValues<Predicate, Value>(facts: { expired: Predicate; live: Predicate },
  values: { expiredStatus: Value; currentStatus: Value; newToken: Value; currentToken: Value },
  logic: Pick<InvitationChoice<Predicate, Value>, 'when'>): { status: Value; token: Value } {
  return { status: logic.when(facts.expired, values.expiredStatus, values.currentStatus),
    token: logic.when(facts.live, values.newToken, values.currentToken) };
}

export function invitationDeliveryWasSent<Status, Predicate>(status: Status,
  logic: { equals(status: Status, expected: 'sent'): Predicate }): Predicate {
  return logic.equals(status, 'sent');
}

export function invitationInviterName(name: string, username: string): string {
  return name.trim() || username;
}
