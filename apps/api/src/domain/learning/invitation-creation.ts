import { normalizeInvitationEmail } from '@videoq/domain/course-invitations';

/** Owner first, followed by membership query order; preserve first occurrence. */
export function invitationMemberEmails(requested: readonly { email: string }[], ownerEmail: string, memberEmails: readonly string[]): string[] {
  const emails = new Set(requested.map(input => input.email));
  const members = new Set<string>();
  for (const raw of [ownerEmail, ...memberEmails]) {
    const email = normalizeInvitationEmail(raw);
    if (email && emails.has(email)) members.add(email);
  }
  return [...members];
}

export function invitationCandidates<Input extends { email: string }>(inputs: readonly Input[], excludedEmails: readonly string[]): Input[] {
  const excluded = new Set(excludedEmails);
  return inputs.filter(input => !excluded.has(input.email));
}

/** A candidate not inserted is an existing/concurrently conflicting invitation.
 * PG can preserve already-read pending row order; D1 classifies after its batch. */
export function uncreatedInvitationEmails(inputs: readonly { email: string }[], memberEmails: readonly string[],
  createdEmails: readonly string[], knownPending: readonly string[] = []): string[] {
  const excluded = new Set([...memberEmails, ...createdEmails]);
  return [...new Set([...knownPending, ...inputs.filter(input => !excluded.has(input.email)).map(input => input.email)])];
}

export interface InvitationCreationLogic<T> { and(left: T, right: T): T }
export function invitationCreationAllowed<T>(facts: { notMember: T; notPending: T }, logic: InvitationCreationLogic<T>): T {
  return logic.and(facts.notMember, facts.notPending);
}
export function invitationPendingExpired<T>(pending: T, expired: T, logic: InvitationCreationLogic<T>): T {
  return logic.and(pending, expired);
}
