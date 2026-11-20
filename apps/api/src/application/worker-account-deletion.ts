export interface AccountDeletionLogic<Predicate> {
  or(...terms: Predicate[]): Predicate;
  not(term: Predicate): Predicate;
}

/** A user already removed is a successful replay; an existing user must still
 * be permanently banned and must not have the administrator role. */
export function accountDeletionForbidden<P>(facts: { banned: P; noExpiry: P; administrator: P }, logic: AccountDeletionLogic<P>): P {
  return logic.or(logic.not(facts.banned), logic.not(facts.noExpiry), facts.administrator);
}

export function accountDeletionVideoOutcome(deleted: boolean): { status: 'progress' | 'denied' } {
  return { status: deleted ? 'progress' : 'denied' };
}

export function accountDeletionDrainOutcome(allowed: boolean, remaining: boolean): { status: 'denied' | 'progress' | 'completed' } {
  return { status: !allowed ? 'denied' : remaining ? 'progress' : 'completed' };
}
