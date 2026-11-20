import type { TranscriptionChoice } from '../application/transcription-policy';

/** Operands are adapter-owned SQL expressions; user data stays bound. */
export const transcriptionStringLogic: TranscriptionChoice<string, string> = {
  and: (...terms) => `(${terms.map(term => `(${term})`).join(' AND ')})`,
  or: (...terms) => `(${terms.map(term => `(${term})`).join(' OR ')})`,
  not: term => `NOT (${term})`,
  choose: (condition, yes, no) => `CASE WHEN ${condition} THEN ${yes} ELSE ${no} END`,
  literal: value => `'${value}'`,
};
