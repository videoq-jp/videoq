import { expect, it } from 'vitest';
import { createMemoryCourseRepository } from '../src/persistence/memory/course-repository';
import { createCourseService } from '../src/features/courses/service';
import { createUseCaseBus } from '../src/application/use-case-bus';
const repository = () => createMemoryCourseRepository({ now: () => new Date('2026-11-27T00:00:00Z') });
it('runs production domain validation with the memory adapter and isolates owners', async () => {
  const repo = repository(), bus = createUseCaseBus(createCourseService(repo));
  const first = await bus.execute('createUserCourse', 'owner', 'A', '');
  const second = await bus.execute('createUserCourse', 'peer', 'B', '');
  expect(await bus.execute('getCourse', first!.id, 'peer')).toBeNull();
  expect(await bus.execute('saveShareLink', first!.id, 'owner', 'has spaces')).toHaveProperty('error');
  expect(await bus.execute('saveShareLink', first!.id, 'owner', 'shared-course')).toEqual({ share_slug: 'shared-course' });
  expect(await bus.execute('saveShareLink', second!.id, 'peer', 'shared-course')).toHaveProperty('conflict');
  expect(await bus.execute('getSharedCourse', 'shared-course')).toMatchObject({ access_role: 'public' });
  first!.name = 'accidental caller mutation';
  expect(await bus.execute('getCourse', first!.id, 'owner')).toMatchObject({ name: 'A' });
});
it('preserves idempotency conflicts, user scope, and deletion without resurrecting receipts', async () => {
  const repo = repository();
  const receipt = { action: 'create_course' as const, key: 'retry', requestHash: 'a'.repeat(64) };
  const [first, replay] = await Promise.all([repo.create('owner', 'A', '', receipt), repo.create('owner', 'A', '', receipt)]);
  expect(first).toEqual({ ok: true, courseId: 1, reused: false });
  expect(replay).toEqual({ ok: true, courseId: 1, reused: true });
  expect(await repo.create('owner', 'B', '', { ...receipt, requestHash: 'b'.repeat(64) })).toEqual({ idempotencyConflict: true });
  expect(await repo.create('peer', 'A', '', receipt)).toMatchObject({ ok: true, reused: false });
  await repo.delete(1, 'owner');
  expect(await repo.create('owner', 'A', '', receipt)).toEqual({ idempotencyConflict: true });
});
it('reorders selected owned slots, rejects duplicates and refuses foreign mutations', async () => {
  const repo = repository();
  await repo.create('owner', 'A', ''); await repo.create('owner', 'B', ''); await repo.create('owner', 'C', '');
  expect(await repo.reorder('owner', [3, 1])).toEqual({ ok: true });
  expect((await repo.listPage('owner', 20, 0)).results.map(row => row.id)).toEqual([3, 2, 1]);
  expect(await repo.reorder('owner', [1, 1])).toEqual({ mismatch: true });
  expect(await repo.update(1, 'peer', { name: 'No' })).toEqual({ notFound: true });
  expect(await repo.delete(1, 'peer')).toEqual({ notFound: true });
  expect(await repo.clearShareSlug(1, 'owner')).toEqual({ notConfigured: true });
});
