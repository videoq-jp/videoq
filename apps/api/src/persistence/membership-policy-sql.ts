import { sql, type SQL } from 'drizzle-orm';
import type { MembershipLogic } from '../application/membership-policy';

/** Expressions come from adapters; user inputs stay bound parameters. */
export const membershipSqlLogic: MembershipLogic<string> = {
  and: (left, right) => `(${left} AND ${right})`,
  or: (left, right) => `(${left} OR ${right})`,
};
export const membershipDrizzleLogic: MembershipLogic<SQL> = {
  and: (left, right) => sql`(${left} AND ${right})`,
  or: (left, right) => sql`(${left} OR ${right})`,
};
