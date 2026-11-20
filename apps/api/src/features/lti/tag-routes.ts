import { canUseLearningTags, canChangeLearningTags, learningTagScope, type LearningOperationAccess } from './operation-policy';
import type { Context, Hono } from 'hono';
import type { AppEnv } from '../../types/bindings';
import { ApiError, toErrorBody } from '../../shared/errors';
import { LmsSyncError } from '../lms/resource';
import { ltiSubjectKey } from './identity';
import { courseTagInput, courseTags } from './course-tags';
import { ltiSessionProof } from './data-lock';

type Authorization = LearningOperationAccess;
export function mountLtiTags(routes: Hono<AppEnv>, authorize: (c: Context<AppEnv>) => Promise<Authorization | { error: Response }>) {
  routes.post('/tags', async c => {
    const access = await authorize(c);
    if ('error' in access) return access.error;
    const { grant } = access;
    if (!canUseLearningTags(access)) return c.json(toErrorBody('FORBIDDEN', 'Course tags are unavailable.'), 403);
    const parsed = courseTagInput.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json(toErrorBody('VALIDATION_ERROR', 'Invalid tag operation.'), 400);
    if (!canChangeLearningTags(access, parsed.data.action))
      return c.json(toErrorBody('FORBIDDEN', 'Course tags are unavailable.'), 403);
    try {
      const proof = ltiSessionProof(grant, access.sessionHash);
      const result = await courseTags(c.env, learningTagScope(access, await ltiSubjectKey(grant), proof), parsed.data);
      return c.json(result);
    } catch (error) {
      if (error instanceof ApiError) return c.json(toErrorBody(error.code, error.expose ? error.message : 'Course tags are unavailable.'), error.status);
      if (error instanceof LmsSyncError) return c.json(toErrorBody('FORBIDDEN', 'Course tags are unavailable.'), 403);
      console.error(JSON.stringify({ event: 'lti_course_tags_failed' }));
      return c.json(toErrorBody('INTERNAL_ERROR', 'Course tags are unavailable.'), 500);
    }
  });
}
