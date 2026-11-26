import { sql, type SQL } from "drizzle-orm";
import type { NativeCourseLogic } from "../domain/learning/native-course-access";
export const nativeCourseDrizzleLogic: NativeCourseLogic<SQL> = {
  and: (left, right) => sql`(${left} AND ${right})`,
  or: (left, right) => sql`(${left} OR ${right})`,
};
