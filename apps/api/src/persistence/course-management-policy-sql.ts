import { sql, type SQL } from "drizzle-orm";
import type {
  CourseManagementLogic,
  CourseRoleChoice,
  CoursePriorityChoice,
} from "../domain/learning/course-management";
export const courseManagementDrizzleLogic: CourseManagementLogic<SQL> = {
  and: (a, b) => sql`(${a} AND ${b})`,
};
export const courseDrizzleRoleChoice: CourseRoleChoice<
  SQL,
  SQL<"owner" | "member">
> = {
  choose: (owned, owner, member) =>
    sql`CASE WHEN ${owned} THEN ${owner} ELSE ${member} END`,
};

export const courseDrizzlePriorityChoice: CoursePriorityChoice<
  SQL,
  SQL<number>
> = {
  choose: (owned, owner, member) =>
    sql`CASE WHEN ${owned} THEN ${owner} ELSE ${member} END`,
};
