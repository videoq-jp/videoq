import { sql, type SQL, type SQLWrapper } from 'drizzle-orm';
import type { QuotaComparison } from '../application/quota-policy';

/** Only adapter-owned expressions and bound parameters may be operands. */
export const quotaSqlComparison: QuotaComparison<string, string> = {
  isUnlimited: limit => `(${limit} IS NULL)`,
  subtract: (left, right) => `(${left})-(${right})`,
  atMost: (left, right) => `((${left})<=(${right}))`,
  lessThan: (left, right) => `((${left})<(${right}))`,
  or: (left, right) => `(${left} OR ${right})`,
};

export const quotaDrizzleComparison: QuotaComparison<SQLWrapper, SQL> = {
  isUnlimited: limit => sql`${limit} IS NULL`,
  subtract: (left, right) => sql`${left} - ${right}`,
  atMost: (left, right) => sql`${left} <= ${right}`,
  lessThan: (left, right) => sql`${left} < ${right}`,
  or: (left, right) => sql`(${left} OR ${right})`,
};
