import { sql, type SQL } from 'drizzle-orm';

export const historyDrizzleChoice = {
  and: (...conditions: SQL[]) => sql.join(conditions, sql` AND `),
  choose: (condition: SQL, yes: SQL, no: SQL) => sql`CASE WHEN ${condition} THEN ${yes} ELSE ${no} END`,
};

/** All operands are closed adapter-owned expressions, never request text. */
export const historyStringChoice = {
  and: (...conditions: string[]) => conditions.join(' AND '),
  choose: (condition: string, yes: string, no: string) => `CASE WHEN ${condition} THEN ${yes} ELSE ${no} END`,
};
