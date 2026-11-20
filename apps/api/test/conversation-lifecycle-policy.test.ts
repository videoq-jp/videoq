import { expect, it } from 'vitest';
import { conversationTitle, conversationCandidateIds, conversationCourseAllowed, conversationMembersAllowed,
  conversationStoredScopeAllowed, conversationStoredScopeConflict, conversationLogShouldExpire, conversationTitleOnCommit,
  conversationBooleanLogic as logic } from '../src/application/conversation-lifecycle';

it('derives the first title with the existing UTF-16 cap and never replaces an existing title', () => {
  expect(conversationTitle(' \n question \t')).toBe('question');
  const title = conversationTitle('a'.repeat(119) + '😀');
  expect(title.length).toBe(120);expect(title.charCodeAt(119)).toBe(0xd83d);
  const choices = { empty: (value: string) => value === '', choose: (condition: boolean, yes: string, no: string) => condition ? yes : no };
  expect(conversationTitleOnCommit('', 'first', choices)).toBe('first');
  expect(conversationTitleOnCommit(' ', 'later', choices)).toBe(' ');
  expect(conversationTitleOnCommit('existing', 'later', choices)).toBe('existing');
});

it('limits shared visitors to supplied browser candidates while account requests ignore that list', () => {
  const ids = ['candidate'];
  expect(conversationCandidateIds('share')).toEqual([]);
  expect(conversationCandidateIds('share', ids)).toBe(ids);
  expect(conversationCandidateIds(null, ids)).toBeNull();
  expect(conversationCandidateIds('', ids)).toBeNull();
});

it('permits empty read/delete scopes but requires owned nonempty scope for model memory', () => {
  expect(conversationCourseAllowed(0, true, true, logic)).toBe(true);
  expect(conversationCourseAllowed(0, true, false, logic)).toBe(false);
  expect(conversationCourseAllowed(2, false, true, logic)).toBe(false);
  expect(conversationCourseAllowed(2, true, false, logic)).toBe(true);
  expect(conversationMembersAllowed(1, 2, logic)).toBe(false);
  expect(conversationMembersAllowed(null, 0, logic)).toBe(false);
  expect(conversationMembersAllowed(0, 0, logic)).toBe(true);
});

it('requires the original subject and whole stored scope', () => {
  for (const subject of [false, true]) for (const scope of [false, true]) {
    expect(conversationStoredScopeAllowed(subject, scope, logic)).toBe(subject && scope);
    expect(conversationStoredScopeConflict(!subject, !scope, logic)).toBe(!(subject && scope));
  }
});

it('prunes attributed turns of expired threads and old logs without a live thread', () => {
  expect(conversationLogShouldExpire(true, false, false, logic)).toBe(true);
  expect(conversationLogShouldExpire(false, true, true, logic)).toBe(true);
  expect(conversationLogShouldExpire(false, true, false, logic)).toBe(false);
  expect(conversationLogShouldExpire(false, false, true, logic)).toBe(false);
});
