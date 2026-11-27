import { expect, it } from 'vitest';
import {
  uniqueMembershipIds, planTagAttachment, membershipCourseAllowed, membershipVideoAllowed,
  membershipOrderAllowed, matchesMembershipOrder, tagAttachmentAllowed, type MembershipLogic,
} from '../src/domain/learning/membership-policy';

const logic: MembershipLogic<boolean> = { and: (left, right) => left && right, or: (left, right) => left || right };

it('keeps first-occurrence order and does not change the requested list', () => {
  const requested = [5, 2, 5, 1, 2];
  expect(uniqueMembershipIds(requested)).toEqual([5, 2, 1]);
  expect(requested).toEqual([5, 2, 5, 1, 2]);
});

it('preserves attached foreign tags but never creates a new foreign link', () => {
  const tags = [
    { id: 1, ownerUserId: 'owner', alreadyLinked: false },
    { id: 2, ownerUserId: 'other', alreadyLinked: true },
  ];
  expect(planTagAttachment([2, 1, 1], tags, 'owner')).toEqual({ kind: 'add', ids: [1] });
  expect(planTagAttachment([1, 2], [{ ...tags[0], alreadyLinked: true }, tags[1]], 'owner')).toEqual({ kind: 'add', ids: [] });
  expect(planTagAttachment([1, 2], [tags[0], { ...tags[1], alreadyLinked: false }], 'owner')).toEqual({ kind: 'missing' });
});

it('rejects a partially missing tag request before planning any addition', () => {
  expect(planTagAttachment([1, 2], [{ id: 1, ownerUserId: 'owner', alreadyLinked: false }], 'owner')).toEqual({ kind: 'missing' });
  expect(planTagAttachment([], [], 'owner')).toEqual({ kind: 'add', ids: [] });
});

it.each([
  { owned: true, native: true, add: true, remove: true },
  { owned: true, native: false, add: false, remove: true },
  { owned: false, native: true, add: false, remove: false },
  { owned: false, native: false, add: false, remove: false },
])('separates new membership and legacy cleanup for $owned / $native', ({ owned, native, add, remove }) => {
  expect(membershipCourseAllowed({ owned, native }, logic)).toBe(add);
  expect(membershipVideoAllowed('add', { owned, native }, logic)).toBe(add);
  expect(membershipVideoAllowed('remove', { owned, native }, logic)).toBe(remove);
});

it('requires a complete unique order even when all requested IDs individually exist', () => {
  expect(membershipOrderAllowed({ sameSize: true, unique: true, allMembers: true }, logic)).toBe(true);
  for (const facts of [
    { sameSize: false, unique: true, allMembers: true },
    { sameSize: true, unique: false, allMembers: true },
    { sameSize: true, unique: true, allMembers: false },
  ]) expect(membershipOrderAllowed(facts, logic)).toBe(false);
});

it('treats ownership and prior attachment as independent admission facts', () => {
  expect(tagAttachmentAllowed({ owned: false, alreadyLinked: true }, logic)).toBe(true);
  expect(tagAttachmentAllowed({ owned: true, alreadyLinked: false }, logic)).toBe(true);
  expect(tagAttachmentAllowed({ owned: false, alreadyLinked: false }, logic)).toBe(false);
});

it.each([
  { requested: [5, 1, 2], members: [1, 2, 5], allowed: true },
  { requested: [1, 1, 2], members: [1, 2, 5], allowed: false },
  { requested: [1, 2], members: [1, 2, 5], allowed: false },
  { requested: [1, 2, 3], members: [1, 2, 5], allowed: false },
  { requested: [], members: [1], allowed: false },
  { requested: [], members: [], allowed: true },
])('validates the entire requested permutation $requested', ({ requested, members, allowed }) => {
  expect(matchesMembershipOrder(requested, members)).toBe(allowed);
});
