import { expect, it } from 'vitest';
import {
  lmsOwnerAvailable, materialTeacherConnectionAccess, materialTeacherConnectionStable,
  materialTeacherCourseMatches, type LmsOwnerLogic,
} from '../src/domain/lms/lms-owner';

const logic: LmsOwnerLogic<number | null, boolean> = {
  and: (left, right) => left && right,
  or: (left, right) => left || right,
  atOrBefore: (expires, now) => expires !== null && now !== null && expires <= now,
};

it.each([
  { label: 'unbanned', active: true, notDeactivated: true, notBanned: true, banExpires: null, allowed: true },
  { label: 'unbanned with a future expiry', active: true, notDeactivated: true, notBanned: true, banExpires: 1001, allowed: true },
  { label: 'indefinite ban', active: true, notDeactivated: true, notBanned: false, banExpires: null, allowed: false },
  { label: 'unexpired ban', active: true, notDeactivated: true, notBanned: false, banExpires: 1001, allowed: false },
  { label: 'expiry equals database clock', active: true, notDeactivated: true, notBanned: false, banExpires: 1000, allowed: true },
  { label: 'expired ban', active: true, notDeactivated: true, notBanned: false, banExpires: 999, allowed: true },
  { label: 'inactive despite no ban', active: false, notDeactivated: true, notBanned: true, banExpires: null, allowed: false },
  { label: 'deactivated despite expired ban', active: true, notDeactivated: false, notBanned: false, banExpires: 999, allowed: false },
])('preserves LMS owner admission for $label', ({ allowed, ...facts }) => {
  expect(lmsOwnerAvailable({ ...facts, now: 1000 }, logic)).toBe(allowed);
});

const connection = { ownerUserId: 'teacher', courseId: 10, resourceLinkId: null, id: 'connection' };
it('derives ownership from the teacher connection and preserves the complete snapshot', () => {
  const result = materialTeacherConnectionAccess(connection);
  expect(result.kind).toBe('ready');
  if (result.kind === 'ready') expect(result.connection).toBe(connection);
  expect(materialTeacherConnectionAccess(connection, 'teacher').kind).toBe('ready');
  expect(materialTeacherConnectionAccess(connection, 'installer')).toEqual({ kind: 'denied', code: 'INSTALLATION_UNAVAILABLE' });
});

it('rejects missing or native-linked connections before comparing an optional grant owner', () => {
  expect(materialTeacherConnectionAccess(null, 'installer')).toEqual({ kind: 'denied', code: 'TEACHER_CONNECTION_REQUIRED' });
  expect(materialTeacherConnectionAccess({ ...connection, resourceLinkId: 'native-entry' }, 'installer'))
    .toEqual({ kind: 'denied', code: 'TEACHER_CONNECTION_REQUIRED' });
});

it('rejects a connection revoked, rebound or native-linked while acquiring locks', () => {
  const expected = { ownerUserId: 'teacher', courseId: 10 };
  expect(materialTeacherConnectionStable(connection, expected)).toBe(true);
  for (const changed of [null, { ...connection, ownerUserId: 'other' }, { ...connection, courseId: 11 }, { ...connection, resourceLinkId: 'native' }]) {
    expect(materialTeacherConnectionStable(changed, expected)).toBe(false);
  }
  expect(materialTeacherCourseMatches({ courseId: 10 }, 10)).toBe(true);
  expect(materialTeacherCourseMatches(null, 10)).toBe(false);
  expect(materialTeacherCourseMatches({ courseId: 11 }, 10)).toBe(false);
});
