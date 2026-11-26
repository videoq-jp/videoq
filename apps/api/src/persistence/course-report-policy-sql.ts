import { and, sql, type SQL, type SQLWrapper } from "drizzle-orm";
import type { ReportLogic } from "../domain/learning/course-report";

export const reportDrizzleLogic: ReportLogic<SQL> & {
  statusIs(status: SQLWrapper, expected: "completed"): SQL;
} = {
  statusIs: (status, expected) => sql`${status}=${expected}`,
  and: (...conditions) => and(...conditions)!,
};
