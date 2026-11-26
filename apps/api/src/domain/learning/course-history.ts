export type CourseHistoryIdentity = { registrationId: string; subjectHash: string; courseId: number; contextId?: string };

export const COURSE_HISTORY_MAX_TURNS = 50;

export function courseHistoryScopeIds(ids: readonly number[]): number[] {
  return [...new Set(ids)].sort((a, b) => a - b);
}

export function courseHistoryAttribution(scope: CourseHistoryIdentity) {
  return { registrationId: scope.registrationId, subjectHash: scope.subjectHash, courseId: scope.courseId,
    ...(scope.contextId ? { contextId: scope.contextId } : {}) };
}

/** JSON validity/coercion and atomic append are adapter concerns. The prior
 * context survives only while live and entirely compatible with current scope. */
export function retainedCourseHistory<Value, Predicate>(facts: {
  live: Predicate; scopeArray: Predicate; turnsArray: Predicate; scopeCompatible: Predicate;
}, prior: Value, empty: Value, logic: {
  and(...conditions: Predicate[]): Predicate;
  choose(condition: Predicate, yes: Value, no: Value): Value;
}): Value {
  return logic.choose(logic.and(facts.live, facts.scopeArray, facts.turnsArray, facts.scopeCompatible), prior, empty);
}
