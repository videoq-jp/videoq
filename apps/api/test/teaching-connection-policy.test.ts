import { expect, it } from 'vitest';
import {
  teachingConnectionConflicts, teachingInstallationRequired, teachingResourceLinkAllowed, selectTeachingCourse,
} from '../src/application/teaching';

const binding = { ownerUserId: 'alice', teacherSubject: 'teacher', courseId: 10 };

it('allows a first connection and the same owner/teacher reconnecting to the same course', () => {
  expect(teachingConnectionConflicts(null, 'alice', 'teacher', 10)).toBe(false);
  expect(teachingConnectionConflicts(binding, 'alice', 'teacher')).toBe(false);
  expect(teachingConnectionConflicts(binding, 'alice', 'teacher', 10)).toBe(false);
});

it.each([
  { owner: 'bob', teacher: 'teacher', course: 10 },
  { owner: 'alice', teacher: 'co-teacher', course: 10 },
  { owner: 'alice', teacher: 'teacher', course: 11 },
])('refuses a different owner, teacher or course: $owner / $teacher / $course', ({ owner, teacher, course }) => {
  expect(teachingConnectionConflicts(binding, owner, teacher, course)).toBe(true);
});

it('retains ownership and teacher identity even when the existing connection is disconnected', () => {
  const disconnected = { ...binding, active: false };
  expect(teachingConnectionConflicts(disconnected, 'bob', 'co-teacher', 10)).toBe(true);
  expect(teachingConnectionConflicts(disconnected, 'alice', 'teacher')).toBe(false);
});

it('requires a first-course selection and reuses a returning connection course', () => {
  expect(selectTeachingCourse(null)).toBeNull();
  expect(selectTeachingCourse(undefined, 42)).toBe(42);
  expect(selectTeachingCourse(binding)).toBe(10);
  expect(selectTeachingCourse(binding, 10)).toBe(10);
  expect(selectTeachingCourse(null, 0)).toBeNull();
});

it('requires an active installation only for Moodle; actual availability stays in the atomic query', () => {
  expect(teachingInstallationRequired('moodle')).toBe(true);
  expect(teachingInstallationRequired('classroom')).toBe(false);
});

it.each([
  { provider: 'moodle' as const, resourceLinkId: undefined, allowed: false },
  { provider: 'moodle' as const, resourceLinkId: '', allowed: false },
  { provider: 'moodle' as const, resourceLinkId: 'native-entry', allowed: true },
  { provider: 'classroom' as const, resourceLinkId: undefined, allowed: true },
])('checks native resource-link mode for $provider / $resourceLinkId', ({ provider, resourceLinkId, allowed }) => {
  expect(teachingResourceLinkAllowed({ provider, resourceLinkId })).toBe(allowed);
});
