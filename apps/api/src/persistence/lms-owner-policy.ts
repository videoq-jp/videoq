import { sql, type SQL, type SQLWrapper } from 'drizzle-orm';
import type { LmsOwnerLogic } from '../application/lms-owner';

/** Operands are only adapter-owned expressions and bound parameters. */
export const lmsOwnerStringLogic: LmsOwnerLogic<string, string> = {
  and: (left, right) => `(${left} AND ${right})`,
  or: (left, right) => `(${left} OR ${right})`,
  atOrBefore: (expires, now) => `(${expires}<=${now})`,
};
export const lmsOwnerDrizzleLogic: LmsOwnerLogic<SQLWrapper, SQL> = {
  and: (left, right) => sql`(${left} AND ${right})`,
  or: (left, right) => sql`(${left} OR ${right})`,
  atOrBefore: (expires, now) => sql`${expires} <= ${now}`,
};
