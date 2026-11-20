import { sql, type SQL, type SQLWrapper } from 'drizzle-orm';
import type { BillingBanLogic, BillingEntitlementChoice } from '../application/billing-state';

/** Column expressions are adapter-owned; the source literal is a closed union. */
export const billingStringEntitlementChoice: BillingEntitlementChoice<string, string, string> = {
  sourceEquals: (source, expected) => `${source}='${expected}'`,
  choose: (predicate, yes, no) => `CASE WHEN ${predicate} THEN ${yes} ELSE ${no} END`,
};
export const billingDrizzleEntitlementChoice: BillingEntitlementChoice<SQLWrapper, SQL, SQL> = {
  sourceEquals: (source, expected) => sql`${source} = ${expected}`,
  choose: (predicate, yes, no) => sql`CASE WHEN ${predicate} THEN ${yes} ELSE ${no} END`,
};
export const billingDrizzleBanLogic: BillingBanLogic<SQLWrapper, SQL> = {
  and: (left, right) => sql`(${left} AND ${right})`,
  or: (left, right) => sql`(${left} OR ${right})`,
  not: value => sql`NOT (${value})`,
  atOrAfter: (expires, now) => sql`${expires} >= ${now}`,
};
