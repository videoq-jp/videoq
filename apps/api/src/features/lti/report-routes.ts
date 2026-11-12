import type { Context, Hono } from 'hono';
import type { z } from 'zod';
import { bodyLimit } from 'hono/body-limit';
import type { AppEnv } from '../../types/bindings';
import { ApiError, toErrorBody } from '../../shared/errors';
import { LmsSyncError } from '../lms/resource';
import type { CourseAccess } from './course-access';
import type { LtiRegistration } from './config';
import type { sessionRecord } from './protocol';
import { ltiSessionProof } from './data-lock';
import { courseReport, courseReportInput } from './course-reports';

type Authorization = { current: CourseAccess; reg: LtiRegistration; grant: z.infer<typeof sessionRecord>;
  sessionHash: string; course: { userId: string; memberVideoIds: number[] } };
export function mountLtiReports(routes: Hono<AppEnv>, authorize: (c: Context<AppEnv>) => Promise<Authorization | { error: Response }>) {
  routes.use('/reports', bodyLimit({ maxSize: 8192, onError: c => c.json(toErrorBody('VALIDATION_ERROR', 'Invalid report request.'), 413) }));
  routes.post('/reports', async c => {
    c.header('Cache-Control', 'private, no-store');
    const access = await authorize(c);
    if ('error' in access) return access.error;
    const { reg, grant, course, current } = access;
    if (!current.permissions.viewReports || !reg.id.startsWith('db:')) return c.json(toErrorBody('FORBIDDEN', 'Course reports are unavailable.'), 403);
    const input = courseReportInput.safeParse(await c.req.json().catch(() => null));
    if (!input.success) return c.json(toErrorBody('VALIDATION_ERROR', 'Choose a valid period of at most 366 days.'), 400);
    try {
      return c.json(await courseReport(c.env, { installationId: reg.id.slice(3), contextId: grant.contextId,
        courseId: grant.courseId, ownerUserId: course.userId,
        sessionProof: ltiSessionProof(grant, access.sessionHash), readable: current.videos.flatMap(video => {
          const binding = reg.resources.find(item => item.videoId === video.videoId && item.courseId === grant.courseId
            && item.contextId === grant.contextId && item.deploymentId === grant.deploymentId);
          return binding?.generation && course.memberVideoIds.includes(video.videoId)
            ? [{ videoId: video.videoId, generation: binding.generation, resourceLinkId: binding.resourceLinkId }] : [];
        }) }, input.data));
    } catch (error) {
      if (error instanceof ApiError) return c.json(toErrorBody(error.code, 'Course reports are unavailable.'), error.status);
      if (error instanceof LmsSyncError) return c.json(toErrorBody('FORBIDDEN', 'Course reports are unavailable.'), 403);
      console.error(JSON.stringify({ event: 'lti_course_report_failed' }));
      return c.json(toErrorBody('INTERNAL_ERROR', 'Course reports are unavailable.'), 500);
    }
  });
}
