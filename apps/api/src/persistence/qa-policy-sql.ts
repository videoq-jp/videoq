import { and, or, not, type SQL } from "drizzle-orm";
import type { QaLogic } from "../domain/qa/policy";

export const qaDrizzleLogic: QaLogic<SQL> = {
  and: (left, right) => and(left, right)!,
  or: (left, right) => or(left, right)!,
  not,
};
