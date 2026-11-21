import { and, or, sql, type SQL, type SQLWrapper } from "drizzle-orm";
export const conversationDrizzleLogic = {
  atLeast: (value: SQLWrapper, minimum: number) => sql`${value}>=${minimum}`,
  equal: (left: SQLWrapper, right: SQLWrapper) => sql`${left}=${right}`,
  and: (left: SQL, right: SQL) => and(left, right)!,
  or: (left: SQL, right: SQL) => or(left, right)!,
  empty: (value: SQLWrapper) => sql`${value}=''`,
  choose: (condition: SQL, yes: SQLWrapper, no: SQLWrapper) =>
    sql`CASE WHEN ${condition} THEN ${yes} ELSE ${no} END`,
};
