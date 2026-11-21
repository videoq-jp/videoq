import { sql, type SQL, type SQLWrapper } from "drizzle-orm";
import type { QuotaComparison } from "../application/quota-policy";

export const quotaDrizzleComparison: QuotaComparison<SQLWrapper, SQL> = {
  isUnlimited: (limit) => sql`${limit} IS NULL`,
  subtract: (left, right) => sql`${left} - ${right}`,
  atMost: (left, right) => sql`${left} <= ${right}`,
  lessThan: (left, right) => sql`${left} < ${right}`,
  or: (left, right) => sql`(${left} OR ${right})`,
};
