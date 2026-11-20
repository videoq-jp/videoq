import { sql, type SQL, type SQLWrapper } from 'drizzle-orm';
import type { MediaEligibilityLogic } from '../application/media-eligibility';

/** Closed status literal and adapter-owned expressions; inputs remain bound. */
export const mediaStringLogic: MediaEligibilityLogic<string, string> = {
  and: (left, right) => `(${left} AND ${right})`,
  statusIs: (status, expected) => `${status}='${expected}'`,
  present: value => `${value} IS NOT NULL`,
  nonempty: value => `${value}<>''`,
};
export const mediaDrizzleLogic: MediaEligibilityLogic<SQLWrapper, SQL> = {
  and: (left, right) => sql`(${left} AND ${right})`,
  statusIs: (status, expected) => sql`${status}=${expected}`,
  present: value => sql`${value} IS NOT NULL`,
  nonempty: value => sql`${value}<>''`,
};
