import { and, or, not, type SQL } from "drizzle-orm";
import type { VisualLogic } from "../application/visual-checkpoint-policy";

export const visualDrizzleLogic: VisualLogic<SQL> = {
  and: (...terms) => and(...terms)!,
  or: (...terms) => or(...terms)!,
  not,
};
