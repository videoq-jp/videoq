import { sql, type SQL, type SQLWrapper } from "drizzle-orm";
import type { MediaEligibilityLogic } from "../application/media-eligibility";
export const mediaDrizzleLogic: MediaEligibilityLogic<SQLWrapper, SQL> = {
  and: (left, right) => sql`(${left} AND ${right})`,
  statusIs: (status, expected) => sql`${status}=${expected}`,
  present: (value) => sql`${value} IS NOT NULL`,
  nonempty: (value) => sql`${value}<>''`,
};
