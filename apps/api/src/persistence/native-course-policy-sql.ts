import { sql, type SQL } from 'drizzle-orm';
import type { NativeCourseLogic } from '../application/native-course-access';

/** Operands are adapter-owned expressions or bound parameters. */
export const nativeCourseStringLogic: NativeCourseLogic<string> = {
  and: (left, right) => `(${left} AND ${right})`,
  or: (left, right) => `(${left} OR ${right})`,
};
export const nativeCourseDrizzleLogic: NativeCourseLogic<SQL> = {
  and: (left, right) => sql`(${left} AND ${right})`,
  or: (left, right) => sql`(${left} OR ${right})`,
};
