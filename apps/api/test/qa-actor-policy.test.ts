import { expect, it } from 'vitest';
import { qaBooleanLogic, qaNativeAccessAllowed, qaNativePermissions, qaQuestionScopeAllowed } from '../src/domain/qa/policy';

it.each([
  { label: 'anonymous reader', authenticated: false, owner: false, post: false, moderate: false },
  { label: 'authenticated learner', authenticated: true, owner: false, post: true, moderate: false },
  { label: 'authenticated owner', authenticated: true, owner: true, post: true, moderate: true },
])('assigns native capabilities for $label', ({ authenticated, owner, post, moderate }) => {
  expect(qaNativePermissions(authenticated, owner)).toEqual({ canPost: post, canVote: post, canDeleteOwn: post, canModerate: moderate });
});

it('does not let native capabilities bypass course-access admission', () => {
  expect(qaNativePermissions(true, false).canPost).toBe(true);
  expect(qaNativeAccessAllowed(false, { owner: false, nativeEnabled: true, member: false, shareMatches: false }, qaBooleanLogic)).toBe(false);
});

it.each([
  { label: 'course-level post with empty scope', sourceUnbound: true, sourceGranted: false, videoUnbound: true, videoGranted: false, allowed: true },
  { label: 'visible source and video', sourceUnbound: false, sourceGranted: true, videoUnbound: false, videoGranted: true, allowed: true },
  { label: 'unbound source with visible video', sourceUnbound: true, sourceGranted: false, videoUnbound: false, videoGranted: true, allowed: true },
  { label: 'visible source with removed video binding', sourceUnbound: false, sourceGranted: true, videoUnbound: true, videoGranted: false, allowed: true },
  { label: 'hidden source despite visible current video', sourceUnbound: false, sourceGranted: false, videoUnbound: false, videoGranted: true, allowed: false },
  { label: 'hidden current video despite visible source', sourceUnbound: false, sourceGranted: true, videoUnbound: false, videoGranted: false, allowed: false },
  { label: 'hidden source after video binding removal', sourceUnbound: false, sourceGranted: false, videoUnbound: true, videoGranted: false, allowed: false },
  { label: 'unbound source with hidden video', sourceUnbound: true, sourceGranted: false, videoUnbound: false, videoGranted: false, allowed: false },
])('keeps Q&A visibility for $label', ({ allowed, ...facts }) => {
  expect(qaQuestionScopeAllowed(facts, qaBooleanLogic)).toBe(allowed);
});
