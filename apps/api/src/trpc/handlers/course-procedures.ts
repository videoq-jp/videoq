import type { UseCaseBus } from '../../application/use-case-bus';
import type { createCourseService } from '../../features/courses/service';
import { rpcError, type HandlersFor } from './shared';

/** Controller/presentation mapping is identical for SQL and local compositions. */
export function createCourseProcedures(options: {
  useCases: () => Promise<UseCaseBus<ReturnType<typeof createCourseService>>>;
  userId: () => string;
  beforeShared?: () => Promise<void>;
  afterShared?: () => Promise<void>;
}): HandlersFor<'courses'> {
  const { useCases, userId } = options;
  return {
    'courses.list': async ({ limit, cursor }) => {
      const offset = cursor ?? 0;
      const { count, results } = await (await useCases()).execute('listCourses', userId(), limit, offset);
      return { data: results, meta: { total: count, limit, offset } };
    },
    'courses.get': async ({ id }) => {
      const course = await (await useCases()).execute('getCourse', id, userId());
      if (!course) return rpcError('NOT_FOUND', 'Course not found');
      return course;
    },
    'courses.shared': async ({ slug }) => {
      await options.beforeShared?.();
      const course = await (await useCases()).execute('getSharedCourse', slug);
      if (!course) return rpcError('NOT_FOUND', 'Share link not found');
      await options.afterShared?.();
      return course;
    },
    'courses.create': async ({ name, description }) => {
      const course = await (await useCases()).execute('createUserCourse', userId(), name, description);
      if (!course || course.access_role === 'public') return rpcError('INTERNAL_SERVER_ERROR', 'Created course could not be loaded');
      return { ...course, access_role: course.access_role };
    },
    'courses.update': async ({ id, ...fields }) => {
      const result = await (await useCases()).execute('updateUserCourse', id, userId(), fields);
      if ('notFound' in result) return rpcError('NOT_FOUND', 'Course not found');
      return result.course;
    },
    'courses.delete': async ({ id }) => {
      const result = await (await useCases()).execute('removeCourse', id, userId());
      if ('notFound' in result) return rpcError('NOT_FOUND', 'Course not found');
      return { success: true };
    },
    'courses.reorder': async ({ courseIds }) => {
      const result = await (await useCases()).execute('reorderUserCourses', userId(), courseIds);
      if ('mismatch' in result) return rpcError('BAD_REQUEST', 'Specified course IDs do not match user courses');
      return { courseIds };
    },
    'courses.createShare': async ({ id, shareSlug }) => {
      const result = await (await useCases()).execute('saveShareLink', id, userId(), shareSlug);
      if ('notFound' in result) return rpcError('NOT_FOUND', 'Course not found');
      if ('error' in result) return rpcError('BAD_REQUEST', result.error ?? 'Bad request');
      if ('conflict' in result) return rpcError('CONFLICT', result.conflict ?? 'Conflict');
      return { message: 'Share link saved', share_slug: result.share_slug };
    },
    'courses.deleteShare': async ({ id }) => {
      const result = await (await useCases()).execute('clearShareLink', id, userId());
      if ('notFound' in result) return rpcError('NOT_FOUND', 'Course not found');
      if ('notConfigured' in result) return rpcError('NOT_FOUND', 'Share link is not configured');
      return { success: true };
    },
  };
}
