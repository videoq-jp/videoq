import { assertCourseNameWorkflow } from './helpers/course-name-workflow-contract';
import { expect, it } from 'vitest';
import { normalizeCourseName } from '@videoq/domain/course-name';
import { inputSchemas } from '@videoq/trpc/inputs';
import { managementToolSchemas } from '../src/tools/management';
import { createCourseService } from '../src/features/courses/service';
import { createMemoryCourseRepository } from '../src/persistence/memory/course-repository';

it.each(['', '   ', 'Course' + String.fromCharCode(0) + 'suffix', 'x'.repeat(256), '😀'.repeat(128)])('rejects invalid course names consistently: %j', async name => {
  const repo = createMemoryCourseRepository({ now: () => new Date('2026-11-27T00:00:00Z') });
  const service = createCourseService(repo);
  expect(normalizeCourseName(name)).toHaveProperty('error');
  expect(inputSchemas['courses.create'].safeParse({ name }).success).toBe(false);
  expect(inputSchemas['courses.update'].safeParse({ id: 1, name }).success).toBe(false);
  expect(managementToolSchemas.create_course.safeParse({ idempotency_key: 'test-key-123', name, description: '' }).success).toBe(false);
  await expect(service.createUserCourse('owner', name, '')).rejects.toMatchObject({ kind: 'validation' });
  await expect(service.createUserCourseIdempotent('owner', name, '', { action: 'create_course', key: 'test', requestHash: 'a'.repeat(64) })).rejects.toMatchObject({ kind: 'validation' });
  expect((await repo.listPage('owner', 20, 0)).count).toBe(0);
});
it.each(['  Lesson  ', 'x'.repeat(255), '😀'.repeat(127) + 'a'])('uses the same normalized name at every boundary: %j', async name => {
  const expected = name.trim();
  expect(inputSchemas['courses.create'].parse({ name }).name).toBe(expected);
  expect(managementToolSchemas.create_course.parse({ idempotency_key: 'test-key-123', name, description: '' }).name).toBe(expected);
  const repo = createMemoryCourseRepository({ now: () => new Date('2026-11-27T00:00:00Z') });
  const service = createCourseService(repo);
  const course = await service.createUserCourse('owner', name, '');
  expect(course?.name).toBe(expected);
  await service.updateUserCourse(course!.id, 'owner', { name: '  Updated  ' });
  expect((await service.getCourse(course!.id, 'owner'))?.name).toBe('Updated');
  await expect(service.updateUserCourse(course!.id, 'owner', { name: '   ' })).rejects.toMatchObject({ kind: 'validation' });
  expect(await service.updateUserCourse(course!.id, 'peer', { name: '   ' })).toEqual({ notFound: true });
});

it('checks the workflow contract shared with miswiring negative controls', async () => { await assertCourseNameWorkflow(createCourseService); });
