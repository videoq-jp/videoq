export const MAX_INLINE_TRANSCRIPT_BYTES = 2 * 1024 * 1024;
export const MAX_MATERIAL_DESCRIPTION_BYTES = 40_000;

export interface ContentReadLogic<Value, Size, Predicate> {
  atMost(size: Size, limit: number): Predicate;
  above(size: Size, limit: number): Predicate;
  choose(condition: Predicate, yes: Value, no: Value): Value;
  nullValue(): Value;
  coalesceFalse(condition: Predicate): Predicate;
}

/** Keep oversized values out of the persistence response. Unknown size produces
 * a null value, but does not claim that the value was too large. */
export function inlineTranscript<Value, Size, Predicate>(value: Value, bytes: Size, logic: ContentReadLogic<Value, Size, Predicate>) {
  return { value: logic.choose(logic.atMost(bytes, MAX_INLINE_TRANSCRIPT_BYTES), value, logic.nullValue()),
    tooLarge: logic.coalesceFalse(logic.above(bytes, MAX_INLINE_TRANSCRIPT_BYTES)) };
}

export function inlineMaterialDescription<Value, Size, Predicate>(value: Value, bytes: Size, logic: ContentReadLogic<Value, Size, Predicate>): Value {
  return logic.choose(logic.atMost(bytes, MAX_MATERIAL_DESCRIPTION_BYTES), value, logic.nullValue());
}

export function evidenceVideoSelected(videoIds: readonly number[], videoId: number): boolean {
  return videoIds.includes(videoId);
}

export function visualEvidenceReady<Status, Predicate>(fileMatches: Predicate, status: Status, logic: {
  and(left: Predicate, right: Predicate): Predicate;
  statusIs(status: Status, expected: 'ready'): Predicate;
}): Predicate {
  return logic.and(fileMatches, logic.statusIs(status, 'ready'));
}

