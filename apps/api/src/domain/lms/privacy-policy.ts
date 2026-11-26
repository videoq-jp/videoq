import { privacyCollections, privacyContextPage, type PrivacyCursor } from './privacy';

export function privacyCatalogPage<T>(rows: readonly T[], context: (row: T) => string) {
  return { version: 1, collections: privacyCollections, ...privacyContextPage(rows, context) };
}
export function privacySubjectsWithData(subjects: readonly string[], present: readonly boolean[]): string[] {
  return subjects.filter((_, index) => present[index]);
}

export type PrivacyCursorKind = 'integer' | 'uuid' | 'opaque';
export function privacyCursorFailure(collection: typeof privacyCollections[number], kind: PrivacyCursorKind,
  id: string | undefined, isUuid: (value: string) => boolean): 'retiredConversation' | 'invalid' | null {
  if (!id) return null;
  if (collection === 'conversations' && isUuid(id)) return 'retiredConversation';
  if (kind === 'integer' && !/^[1-9][0-9]{0,17}$/.test(id) || kind === 'uuid' && !isUuid(id)) return 'invalid';
  return null;
}
export function privacyRecordCursor(cursor: PrivacyCursor | undefined): string | undefined {
  return cursor?.record?.id ?? cursor?.after;
}

export interface PrivacyLogic<Value, Predicate> {
  and(left: Predicate, right: Predicate): Predicate;
  or(left: Predicate, right: Predicate): Predicate;
  coalesce(...values: Value[]): Value;
  orphan(): Value;
  choose(condition: Predicate, yes: Value, no: Value): Value;
}
export function privacyCourseContext<Value, Predicate>(mapped: Value, teaching: Value, logic: PrivacyLogic<Value, Predicate>): Value {
  return logic.coalesce(mapped, teaching, logic.orphan());
}
export function privacyRecentContext<Value, Predicate>(explicit: Value, fallback: Value, logic: PrivacyLogic<Value, Predicate>): Value {
  return logic.coalesce(explicit, fallback);
}
export function privacyReportContext<Value, Predicate>(mapped: Predicate, teaching: Predicate, stored: Value, logic: PrivacyLogic<Value, Predicate>): Value {
  return logic.choose(logic.or(mapped, teaching), stored, logic.orphan());
}
export function privacyRecordAllowed<Value, Predicate>(subject: Predicate, allContexts: Predicate, selectedContext: Predicate,
  logic: PrivacyLogic<Value, Predicate>): Predicate {
  return logic.and(subject, logic.or(allContexts, selectedContext));
}
export function privacyHistoryNeedsUpgrade<Value, Predicate>(live: Predicate, registrationMissing: Predicate, subjectMissing: Predicate,
  logic: PrivacyLogic<Value, Predicate>): Predicate {
  return logic.and(live, logic.or(registrationMissing, subjectMissing));
}

/** Erasure keeps discussion structure while removing personal text/attribution. */
export function privacyQuestionAnonymization() {
  return { title: '[deleted]', body: '[deleted]', author: '0'.repeat(64), instructor: false, featured: false };
}
export function privacyReplyAnonymization() {
  return { body: '[deleted]', author: '0'.repeat(64), instructor: false };
}
export const privacyOperationBarriers = [
  { collection: 'material_operations', operation: 'material', count: 'materialOperations' },
  { collection: 'tag_operations', operation: 'tag', count: 'tagOperations' },
] as const;

/** Initial session/feedback revocation is atomic with all later effects. A
 * backend may combine that pair in one statement while preserving selectors. */
export function privacyErasurePlan() {
  return [
    { target: 'feedback', kind: 'delete' }, { target: 'sessions', kind: 'delete' },
    { target: 'recentHistory', kind: 'delete' }, { target: 'conversations', kind: 'delete' },
    { target: 'logs', kind: 'delete' },
    { target: 'questions', kind: 'anonymize', fields: privacyQuestionAnonymization() },
    { target: 'replies', kind: 'anonymize', fields: privacyReplyAnonymization() },
    { target: 'votes', kind: 'delete' },
    { target: 'moderation', kind: 'clearAttribution', actor: null },
    ...privacyOperationBarriers.map(barrier => ({ target: barrier.count, kind: 'delete' as const })),
    { target: 'reportAccesses', kind: 'delete' },
  ] as const;
}
