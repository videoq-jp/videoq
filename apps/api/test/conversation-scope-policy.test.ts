import { expect, it } from 'vitest';
import { conversationThreadInput, type ConversationScope } from '../src/application/conversation-scope';
import { conversationThreadId } from '../src/shared/conversation-scope';

const base: ConversationScope = { ownerUserId: 'owner', actorUserId: 'alice', courseId: 1, shareSlug: null };
// Captured from the original production implementation before extraction.
const identities: { scope: ConversationScope; expected: string }[] = [
  { scope: base, expected: '6982549d152f1d4146c6a380e4e09b5322b39a2c499fba125d2d463b41fc70e4' },
  { scope: { ...base, actorUserId: 'bob' }, expected: 'efc8974cd65d430cc556ffa1131750f5553c28fcee42d88826d4597f758c874d' },
  { scope: { ...base, actorUserId: null, shareSlug: 'course-share', visitorSessionId: 'visitor-a' },
    expected: '94fe38fbe5a7af20945da8e245e2fba0f83abc2878f47c27cfa1f91cc8aff149' },
  { scope: { ...base, actorUserId: null, ltiSubject: { subjectKey: 'a'.repeat(64), resourceVideoIds: [3, 1, 3] } },
    expected: '0c842b736eaae53c783f73ccce7fe7084a096bbd01f1b895ba9c5e84eb654fbc' },
];

it.each(identities)('preserves the persisted conversation namespace: $expected', async ({ scope, expected }) => {
  const original = structuredClone(scope);
  await expect(conversationThreadId(scope, 'existing-conversation')).resolves.toBe(expected);
  expect(scope).toEqual(original);
});

it('requires a visitor identity for shared conversations', () => {
  expect(() => conversationThreadInput({ ...base, shareSlug: 'course-share' }, 'conversation')).toThrow('visitor session');
});

it.each([
  { actorUserId: 'actor', courseId: 1, shareSlug: null },
  { actorUserId: null, courseId: 0, shareSlug: null },
  { actorUserId: null, courseId: 1.5, shareSlug: null },
  { actorUserId: null, courseId: 1, shareSlug: 'shared' },
])('rejects mixed or invalid LTI identity scopes', patch => {
  expect(() => conversationThreadInput({ ...base, ...patch, visitorSessionId: 'visitor',
    ltiSubject: { subjectKey: 'a'.repeat(64), resourceVideoIds: [1] } }, 'conversation'))
    .toThrow('Invalid LTI conversation scope');
});
