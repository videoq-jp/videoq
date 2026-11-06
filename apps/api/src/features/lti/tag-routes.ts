import type { Context, Hono } from 'hono';
import type { z } from 'zod';
import type { AppEnv } from '../../types/bindings';
import { ApiError, toErrorBody } from '../../shared/errors';
import { LmsSyncError } from '../lms/resource';
import type { CourseAccess } from './course-access';
import type { LtiRegistration } from './config';
import type { sessionRecord } from './protocol';
import { ltiSubjectKey } from './identity';
import { courseTagInput, courseTags } from './course-tags';

type Authorization = { current: CourseAccess; reg: LtiRegistration; grant: z.infer<typeof sessionRecord>;
  course: { userId: string; memberVideoIds: number[] } };
export function mountLtiTags(routes: Hono<AppEnv>, authorize: (c: Context<AppEnv>) => Promise<Authorization | { error: Response }>) {
  routes.post('/tags', async c => {
    const access = await authorize(c);
    if ('error' in access) return access.error;
    const { reg, grant, course, current } = access;
    if (!reg.id.startsWith('db:')) return c.json(toErrorBody('FORBIDDEN', 'Course tags are unavailable.'), 403);
    const parsed = courseTagInput.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json(toErrorBody('VALIDATION_ERROR', 'Invalid tag operation.'), 400);
    if (parsed.data.action !== 'list' && !current.permissions.manageContent)
      return c.json(toErrorBody('FORBIDDEN', 'Course tags are unavailable.'), 403);
    try {
      const result = await courseTags(c.env, { installationId: reg.id.slice(3), contextId: grant.contextId,
        courseId: grant.courseId, ownerUserId: course.userId, actorKey: await ltiSubjectKey(grant), manage: current.permissions.manageContent,
        readableVideoIds: current.videos.map(v => v.videoId).filter(id => course.memberVideoIds.includes(id)),
        management: (current.managementVideos ?? []).flatMap(video => {
          const binding = reg.resources.find(item => item.videoId === video.videoId && item.courseId === grant.courseId
            && item.contextId === grant.contextId && item.deploymentId === grant.deploymentId);
          return current.permissions.manageContent && video.management && binding && course.memberVideoIds.includes(video.videoId)
            ? [{ videoId: video.videoId, resourceLinkId: binding.resourceLinkId, generation: video.management.generation }] : [];
        }),
      }, parsed.data);
      return c.json(result);
    } catch (error) {
      if (error instanceof ApiError) return c.json(toErrorBody(error.code, error.expose ? error.message : 'Course tags are unavailable.'), error.status);
      if (error instanceof LmsSyncError) return c.json(toErrorBody('FORBIDDEN', 'Course tags are unavailable.'), 403);
      console.error(JSON.stringify({ event: 'lti_course_tags_failed' }));
      return c.json(toErrorBody('INTERNAL_ERROR', 'Course tags are unavailable.'), 500);
    }
  });
}
