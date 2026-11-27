import { and, or, not, sql, type SQL } from "drizzle-orm";
import type { TranscriptionChoice } from "../domain/media/transcription-policy";

export const transcriptionDrizzleLogic: TranscriptionChoice<SQL, SQL> = {
  and: (...terms) => and(...terms)!,
  or: (...terms) => or(...terms)!,
  not: (term) => not(term),
  choose: (condition, yes, no) =>
    sql`CASE WHEN ${condition} THEN ${yes} ELSE ${no} END`,
  literal: (value) => sql`${value}`,
};
