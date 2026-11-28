import { expect, it, vi } from 'vitest';
import { inputSchemas } from '@videoq/trpc/inputs';
import { qaInputSchemas } from '../../../packages/trpc/src/qa';
import { createQaService } from '../src/features/qa/core';
import { createCourseService } from '../src/features/courses/service';
import { createMemoryCourseRepository } from '../src/persistence/memory/course-repository';
import type { QaRepository } from '../src/persistence/contracts/qa-repository';

const nul = 'Query' + String.fromCharCode(0) + 'suffix';
const search = { courseId: 1, search: nul, unanswered: false, sort: 'recent' as const, offset: 0, limit: 20 };

it.each(['qa.search', 'videos.q', 'videos.status', 'courses.shared'] as const)('rejects NUL in public %s', name => {
  const result = name === 'qa.search' ? qaInputSchemas['qa.list'].safeParse(search)
    : name === 'courses.shared' ? inputSchemas['courses.shared'].safeParse({ slug: nul })
      : inputSchemas['videos.list'].safeParse(name === 'videos.q' ? { q: nul } : { status: nul });
  expect(result.success).toBe(false);
});

it('rejects a direct Q&A search before persistence', async () => {
  const repository: QaRepository = { list: vi.fn().mockResolvedValue({ items: [], total: 0, canPost: true }), get: vi.fn(), mutate: vi.fn() };
  await expect(createQaService(repository).listQuestions('actor', search)).rejects.toMatchObject({ kind: 'validation' });
  expect(repository.list).not.toHaveBeenCalled();
});

it('rejects a direct shared lookup before persistence', async () => {
  const repository = createMemoryCourseRepository({ now: () => new Date('2026-11-28') });
  const getShared = vi.spyOn(repository, 'getShared');
  await expect(createCourseService(repository).getSharedCourse(nul)).rejects.toMatchObject({ kind: 'validation' });
  expect(getShared).not.toHaveBeenCalled();
});

it('preserves Unicode, punctuation, empty queries, defaults and public normalization', () => {
  const text = '日本語 😀 e\u0301 %_\\\'';
  expect(qaInputSchemas['qa.list'].parse({ courseId: 1, search: ` ${text} ` }).search).toBe(text);
  expect(qaInputSchemas['qa.list'].parse({ courseId: 1 }).search).toBe('');
  expect(inputSchemas['videos.list'].parse({ q: ` ${text} `, status: ' unknown ' })).toMatchObject({ q: ` ${text} `, status: ' unknown ' });
  expect(inputSchemas['videos.list'].parse({ q: '', status: '' })).toMatchObject({ q: '', status: '' });
  expect(inputSchemas['courses.shared'].parse({ slug: ' Mixed-Case ' }).slug).toBe(' Mixed-Case ');
});

it('preserves valid Q&A authorization failures and shared notFound results', async () => {
  const failure = new Error('existing authorization failure');
  const repository: QaRepository = { list: vi.fn().mockRejectedValue(failure), get: vi.fn(), mutate: vi.fn() };
  const query = { ...search, search: '日本語 %_' };
  await expect(createQaService(repository).listQuestions('actor', query)).rejects.toBe(failure);
  expect(repository.list).toHaveBeenCalledExactlyOnceWith('actor', query);
  const courses = createMemoryCourseRepository({ now: () => new Date('2026-11-28') });
  const getShared = vi.spyOn(courses, 'getShared');
  await expect(createCourseService(courses).getSharedCourse('Missing-Case')).resolves.toBeNull();
  expect(getShared).toHaveBeenCalledExactlyOnceWith('Missing-Case', { includeTags: false });
});
