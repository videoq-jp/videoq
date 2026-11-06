import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { z } from 'zod';
import type { AppEnv } from '../../types/bindings';
import type { CourseAccess } from './course-access';
import type { LtiRegistration } from './config';
import type { sessionRecord } from './protocol';
import { materialManagementInput, manageLtiMaterial } from './material-management';
import { ltiSubjectKey } from './identity';
import { ApiError, toErrorBody } from '../../shared/errors';
import { LmsSyncError } from '../lms/resource';
import { processExternalTaskById } from '../../lib/external-tasks';

type Authorization = { current: CourseAccess; reg: LtiRegistration; grant: z.infer<typeof sessionRecord>;
  course: { userId: string; memberVideoIds: number[] } };
export function mountLtiManagement(routes: Hono<AppEnv>, authorize: (c:Context<AppEnv>) => Promise<Authorization|{error:Response}>) {
  routes.use('/management',bodyLimit({maxSize:5*1024*1024,onError:c=>c.json(toErrorBody('VALIDATION_ERROR','Material request is too large.'),413)}));
  routes.post('/management',async c=>{
    const access=await authorize(c);
    if ('error' in access) return access.error;
    const {grant,reg,current,course}=access;
    if (!reg.id.startsWith('db:') || !current.permissions.manageContent)
      return c.json(toErrorBody('FORBIDDEN','Material management is unavailable.'),403);
    const parsed=materialManagementInput.safeParse(await c.req.json().catch(()=>null));
    if (!parsed.success) return c.json(toErrorBody('VALIDATION_ERROR','Invalid material operation.'),400);
    const input=parsed.data;
    const material=current.managementVideos?.find(item=>item.videoId===input.videoId);
    const binding=reg.resources.find(item=>item.videoId===input.videoId && item.courseId===grant.courseId
      && item.contextId===grant.contextId && item.deploymentId===grant.deploymentId);
    if (!material?.management || !binding || !course.memberVideoIds.includes(input.videoId))
      return c.json(toErrorBody('FORBIDDEN','Material management is unavailable.'),403);
    try {
      const result=await manageLtiMaterial(c.env,{installationId:reg.id.slice(3),ownerUserId:course.userId,
        courseId:grant.courseId,contextId:grant.contextId,resourceLinkId:binding.resourceLinkId,videoId:input.videoId,
        generation:material.management.generation,actorKey:await ltiSubjectKey(grant)},input);
      if (result.externalTaskId!==null) {
        try { await processExternalTaskById(c.env,result.externalTaskId); }
        catch { console.error(JSON.stringify({event:'lti_material_dispatch_deferred'})); }
      }
      return c.json({material:result.material,reused:result.reused}, result.externalTaskId===null ? 200 : 202);
    } catch(error) {
      if (error instanceof ApiError) return c.json(toErrorBody(error.code,error.expose?error.message:'Material management is unavailable.'),error.status);
      if (error instanceof LmsSyncError) return c.json(toErrorBody('FORBIDDEN','Material management is unavailable.'),403);
      console.error(JSON.stringify({event:'lti_material_operation_failed'}));
      return c.json(toErrorBody('INTERNAL_ERROR','Material management is unavailable.'),500);
    }
  });
}
