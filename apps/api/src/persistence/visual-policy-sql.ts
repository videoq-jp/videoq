import { and, or, not, type SQL } from "drizzle-orm";
import type { VisualLogic } from "../domain/media/visual-checkpoint-policy";

export const visualDrizzleLogic: VisualLogic<SQL> = {
  and: (...terms) => and(...terms)!,
  or: (...terms) => or(...terms)!,
  not,
};
