import { sql, type SQL } from "drizzle-orm";

export const historyDrizzleChoice = {
  and: (...conditions: SQL[]) => sql.join(conditions, sql` AND `),
  choose: (condition: SQL, yes: SQL, no: SQL) =>
    sql`CASE WHEN ${condition} THEN ${yes} ELSE ${no} END`,
};
