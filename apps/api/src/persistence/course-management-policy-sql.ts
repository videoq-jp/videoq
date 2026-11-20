import { sql, type SQL } from 'drizzle-orm';
import type { CourseManagementLogic, CourseOrderPlanning, CourseRoleChoice, CoursePriorityChoice } from '../application/course-management';

export const courseManagementStringLogic: CourseManagementLogic<string> = { and: (a, b) => `(${a} AND ${b})` };
export const courseManagementDrizzleLogic: CourseManagementLogic<SQL> = { and: (a, b) => sql`(${a} AND ${b})` };
export const courseDrizzleRoleChoice: CourseRoleChoice<SQL, SQL<'owner' | 'member'>> = {
  choose: (owned, owner, member) => sql`CASE WHEN ${owned} THEN ${owner} ELSE ${member} END`,
};

/** Adapter-owned relations only; parameters in these fragments remain bound by
 * the caller in their original order. Stable ID breaks ties between equal slots. */
export const courseD1OrderPlanning: CourseOrderPlanning<string, string, string> = {
  sortAscending: selected => `SELECT display_order,row_number() OVER(ORDER BY display_order,id)-1 AS ordinal FROM (${selected})`,
  assignInRequestOrder: (requested, sorted) => `slots AS MATERIALIZED(${sorted}),
    desired AS MATERIALIZED(SELECT input.value AS id,slots.display_order FROM ${requested} input JOIN slots ON slots.ordinal=CAST(input.key AS INTEGER))`,
};

export const courseDrizzlePriorityChoice: CoursePriorityChoice<SQL, SQL<number>> = {
  choose: (owned, owner, member) => sql`CASE WHEN ${owned} THEN ${owner} ELSE ${member} END`,
};
