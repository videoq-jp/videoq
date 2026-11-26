import { sql, type SQL, type SQLWrapper } from "drizzle-orm";
import type { ContentReadLogic } from '../domain/media/content-read';

/** Operands are adapter-owned expressions; limits are application constants. */
export const contentDrizzleLogic: ContentReadLogic<SQL, SQLWrapper, SQL> = {
  atMost: (size, limit) => sql`${size} <= ${limit}`,
  above: (size, limit) => sql`${size} > ${limit}`,
  choose: (condition, yes, no) =>
    sql`CASE WHEN ${condition} THEN ${yes} ELSE ${no} END`,
  nullValue: () => sql`NULL`,
  coalesceFalse: (condition) => sql`COALESCE(${condition}, false)`,
};
export const visualReadDrizzleLogic = {
  and: (left: SQL, right: SQL) => sql`(${left} AND ${right})`,
  statusIs: (status: SQLWrapper, expected: "ready") =>
    sql`${status}=${expected}`,
};
