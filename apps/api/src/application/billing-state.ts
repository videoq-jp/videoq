import { isPaidPlan, type PlanCode } from './billing-catalog';

/** Unknown stored codes retain the established free-plan fallback. */
export function normalizeStoredPlanCode(value: string): PlanCode {
  return isPaidPlan(value) ? value : 'free';
}

export interface BillingEntitlementChoice<Source, Value, Predicate> {
  sourceEquals(source: Source, expected: 'plan'): Predicate;
  choose(predicate: Predicate, yes: Value, no: Value): Value;
}

/** Evaluate the current source at commit time so provider reconciliation cannot
 * overwrite administrator or deployment-managed allowances. */
export function selectBillingEntitlement<Source, Value, Predicate>(source: Source, proposed: Value, current: Value,
  logic: BillingEntitlementChoice<Source, Value, Predicate>): Value {
  return logic.choose(logic.sourceEquals(source, 'plan'), proposed, current);
}

export interface BillingBanLogic<Time, Predicate> {
  and(left: Predicate, right: Predicate): Predicate;
  or(left: Predicate, right: Predicate): Predicate;
  not(value: Predicate): Predicate;
  atOrAfter(expires: Time, now: Time): Predicate;
}

/** Billing keeps its ban-only admission rule. A ban expires strictly before now;
 * active/deactivated account flags are not part of this established contract.
 * SQL adapters preserve unknown/null predicate results, admitting only true. */
export function billingAccountAvailable<Time, Predicate>(facts: {
  banned: Predicate; noExpiry: Predicate; expires: Time; now: Time;
}, logic: BillingBanLogic<Time, Predicate>): Predicate {
  return logic.not(logic.and(facts.banned, logic.or(facts.noExpiry, logic.atOrAfter(facts.expires, facts.now))));
}
