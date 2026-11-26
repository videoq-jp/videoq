import { and, or, sql, type SQL } from "drizzle-orm";
import { ORPHAN_CONTEXT } from '../domain/lms/privacy';
import type { PrivacyLogic } from '../domain/lms/privacy-policy';

export const privacyDrizzleLogic: PrivacyLogic<SQL, SQL> = {
  and: (left, right) => and(left, right)!,
  or: (left, right) => or(left, right)!,
  coalesce: (...values) => sql`coalesce(${sql.join(values, sql`,`)})`,
  orphan: () => sql`${ORPHAN_CONTEXT}`,
  choose: (condition, yes, no) =>
    sql`CASE WHEN ${condition} THEN ${yes} ELSE ${no} END`,
};
