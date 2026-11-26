import { sql, type SQL } from 'drizzle-orm';
import type { InvitationChoice } from '../domain/learning/invitation-lifecycle';

/** All expressions are adapter-owned; caller values stay bound parameters. */
export const invitationStringChoice: InvitationChoice<string, string> = {
  and: (left, right) => `(${left} AND ${right})`,
  when: (condition, yes, no) => `CASE WHEN ${condition} THEN ${yes} ELSE ${no} END`,
};

export const invitationDrizzleLogic = {
  and: (left: SQL, right: SQL) => sql`(${left} AND ${right})`,
};
export const invitationStringDeliveryStatus = {
  equals: (status: string, expected: 'sent') => `${status}='${expected}'`,
};
