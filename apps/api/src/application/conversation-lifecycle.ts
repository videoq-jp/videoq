export const CONVERSATION_RETENTION_DAYS = 30;

export function conversationTitle(question: string): string {
  return question.trim().slice(0, 120);
}

/** Shared visitors can list only candidates remembered by their browser. The
 * independent persisted scope still authorizes each returned conversation. */
export function conversationCandidateIds(shareSlug: string | null, ids?: string[]): string[] | null {
  return shareSlug ? ids ?? [] : null;
}

export function conversationCourseAllowed<Value, Predicate>(count: Value, owned: Predicate, allowEmpty: boolean,
  logic: { atLeast(value: Value, minimum: number): Predicate; and(left: Predicate, right: Predicate): Predicate }): Predicate {
  return logic.and(logic.atLeast(count, allowEmpty ? 0 : 1), owned);
}

export function conversationMembersAllowed<Value, Predicate>(actual: Value, expected: Value,
  logic: { equal(left: Value, right: Value): Predicate }): Predicate {
  return logic.equal(actual, expected);
}

export function conversationStoredScopeAllowed<Predicate>(subjectMatches: Predicate, scopeContained: Predicate,
  logic: { and(left: Predicate, right: Predicate): Predicate }): Predicate {
  return logic.and(subjectMatches, scopeContained);
}

export function conversationStoredScopeConflict<Predicate>(subjectDiffers: Predicate, missingSource: Predicate,
  logic: { or(left: Predicate, right: Predicate): Predicate }): Predicate {
  return logic.or(subjectDiffers, missingSource);
}

export function conversationLogShouldExpire<Predicate>(expiredThread: Predicate, oldLog: Predicate, noLiveThread: Predicate,
  logic: { and(left: Predicate, right: Predicate): Predicate; or(left: Predicate, right: Predicate): Predicate }): Predicate {
  return logic.or(expiredThread, logic.and(oldLog, noLiveThread));
}

export function conversationTitleOnCommit<Value, Predicate>(current: Value, proposed: Value,
  logic: { empty(value: Value): Predicate; choose(condition: Predicate, yes: Value, no: Value): Value }): Value {
  return logic.choose(logic.empty(current), proposed, current);
}

export const conversationBooleanLogic = {
  atLeast: (value: number, minimum: number) => value >= minimum,
  equal: (left: number | null, right: number | null) => left === right,
  and: (left: boolean, right: boolean) => left && right,
  or: (left: boolean, right: boolean) => left || right,
};
