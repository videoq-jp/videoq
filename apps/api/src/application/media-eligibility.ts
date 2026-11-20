/** Same policies evaluate normalized facts or atomic database predicates. */
export interface MediaEligibilityLogic<Value, Predicate> {
  and(left: Predicate, right: Predicate): Predicate;
  statusIs(status: Value, expected: 'completed'): Predicate;
  present(value: Value): Predicate;
  nonempty(value: Value): Predicate;
}

export function learningVideoAllowed<Value, Predicate>(owned: Predicate, status: Value,
  logic: MediaEligibilityLogic<Value, Predicate>): Predicate {
  return logic.and(owned, logic.statusIs(status, 'completed'));
}

/** Whitespace-only transcripts remain candidates; do not trim stored content. */
export function reindexCandidateAllowed<Value, Predicate>(status: Value, transcript: Value,
  logic: MediaEligibilityLogic<Value, Predicate>): Predicate {
  return logic.and(logic.and(logic.statusIs(status, 'completed'), logic.present(transcript)), logic.nonempty(transcript));
}

/** A linked native course must retain its original teacher-owner binding and
 * an active connection. Its managed-by-LMS flag is not an additional condition. */
export function linkedCourseAllowed<Predicate>(facts: { ownerMatches: Predicate; nativeEnabled: Predicate; connectionActive: Predicate },
  logic: { and(left: Predicate, right: Predicate): Predicate }): Predicate {
  return logic.and(logic.and(facts.ownerMatches, facts.nativeEnabled), facts.connectionActive);
}

export function linkedLessonTitle(title: string | null, courseTitle: string): string {
  return title || courseTitle;
}

export const mediaBooleanLogic: MediaEligibilityLogic<string | null, boolean> = {
  and: (left, right) => left && right,
  statusIs: (status, expected) => status === expected,
  present: value => value !== null,
  nonempty: value => value !== '',
};
