import { ORPHAN_CONTEXT } from '../application/privacy';
import type { PrivacyLogic } from '../application/privacy-policy';

/** Closed expressions only; actual identities, contexts and cursor values bind. */
export const privacyStringLogic: PrivacyLogic<string, string> = {
  and: (left, right) => `(${left}) AND (${right})`,
  or: (left, right) => `(${left} OR ${right})`,
  coalesce: (...values) => `coalesce(${values.join(',')})`,
  orphan: () => `'${ORPHAN_CONTEXT}'`,
  choose: (condition, yes, no) => `CASE WHEN ${condition} THEN ${yes} ELSE ${no} END`,
};
