import { sql, type SQL, type SQLWrapper } from "drizzle-orm";
import type { LmsOwnerLogic } from "../domain/lms/lms-owner";
export const lmsOwnerDrizzleLogic: LmsOwnerLogic<SQLWrapper, SQL> = {
  and: (left, right) => sql`(${left} AND ${right})`,
  or: (left, right) => sql`(${left} OR ${right})`,
  atOrBefore: (expires, now) => sql`${expires} <= ${now}`,
};
