import { canReadLearningReports, learningReportScope, type LearningOperationAccess } from './operation-policy';
import type { Context, Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { AppEnv } from '../../types/bindings';
import { ApiError, toErrorBody } from '../../shared/errors';
import { LmsSyncError } from '../lms/resource';
import { ltiSessionProof } from './data-lock';
import { courseReport, courseReportInput } from './course-reports';

type Authorization = LearningOperationAccess;
export function mountLtiReports(routes: Hono<AppEnv>, authorize: (c: Context<AppEnv>) => Promise<Authorization | { error: Response }>) {
  routes.use('/reports', bodyLimit({ maxSize: 8192, onError: c => c.json(toErrorBody('VALIDATION_ERROR', 'Invalid report request.'), 413) }));
  routes.post('/reports', async c => {
    c.header('Cache-Control', 'private, no-store');
    const access = await authorize(c);
    if ('error' in access) return access.error;
    const { grant } = access;
    if (!canReadLearningReports(access)) return c.json(toErrorBody('FORBIDDEN', 'Course reports are unavailable.'), 403);
    const input = courseReportInput.safeParse(await c.req.json().catch(() => null));
    if (!input.success) return c.json(toErrorBody('VALIDATION_ERROR', 'Choose a valid period of at most 366 days.'), 400);
    try {
      return c.json(await courseReport(c.env, learningReportScope(access, ltiSessionProof(grant, access.sessionHash)), input.data));
    } catch (error) {
      if (error instanceof ApiError) return c.json(toErrorBody(error.code, 'Course reports are unavailable.'), error.status);
      if (error instanceof LmsSyncError) return c.json(toErrorBody('FORBIDDEN', 'Course reports are unavailable.'), 403);
      console.error(JSON.stringify({ event: 'lti_course_report_failed' }));
      return c.json(toErrorBody('INTERNAL_ERROR', 'Course reports are unavailable.'), 500);
    }
  });
}
