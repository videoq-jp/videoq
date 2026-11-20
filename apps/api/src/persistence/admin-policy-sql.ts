import { sql, type SQL, type SQLWrapper } from 'drizzle-orm';
import type { SubscriptionChoice } from '../application/billing-catalog';

export const adminPostgresRoleLogic = {
  includes: (role: SQLWrapper, expected: 'admin') => sql<boolean>`COALESCE(${expected} = ANY(string_to_array(${role}, ',')), false)`,
};
export const adminD1RoleLogic = {
  includes: (role: SQLWrapper, expected: 'admin') => sql<number>`instr(','||coalesce(${role},'')||',',${',' + expected + ','})>0`,
};
/** Closed role token, adapter-owned column expression. No input SQL identifiers. */
export const adminD1StringRoleLogic = {
  includes: (role: string, expected: 'admin') => `instr(','||coalesce(${role},'')||',',',${expected},')>0`,
};
export const adminStringNegation = { not: (value: string) => `NOT (${value})` };
export const adminDrizzleNegation = { not: (value: SQL) => sql`NOT (${value})` };

export const subscriptionDrizzleChoice: SubscriptionChoice<SQLWrapper, SQLWrapper, SQL, SQL> = {
  usable: (status, allowed) => sql`${status} IN (${sql.join(allowed.map(value => sql`${value}`), sql`,`)})`,
  planIs: (plan, expected) => sql`${plan} = ${expected}`,
  and: (left, right) => sql`(${left} AND ${right})`,
  choose: (condition, yes, no) => sql`CASE WHEN ${condition} THEN ${yes} ELSE ${no} END`,
};
