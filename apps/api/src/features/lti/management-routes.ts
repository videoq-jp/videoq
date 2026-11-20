import { canManageLearningMaterials, learningManagedMaterialScope, type LearningOperationAccess } from './operation-policy';
import { executeLearningMaterialOperation } from '../material-management/service';
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { AppEnv } from '../../types/bindings';
import { materialManagementInput, manageLtiMaterial } from './material-management';
import { ltiSubjectKey } from './identity';
import { ltiSessionProof } from './data-lock';
import { ApiError, toErrorBody } from '../../shared/errors';
import { LmsSyncError } from '../lms/resource';
import { processExternalTaskById } from '../../lib/external-tasks';

type Authorization = LearningOperationAccess;
export function mountLtiManagement(routes: Hono<AppEnv>, authorize: (c:Context<AppEnv>) => Promise<Authorization|{error:Response}>) {
  routes.use('/management',bodyLimit({maxSize:5*1024*1024,onError:c=>c.json(toErrorBody('VALIDATION_ERROR','Material request is too large.'),413)}));
  routes.post('/management',async c=>{
    const access=await authorize(c);
    if ('error' in access) return access.error;
    const {grant}=access;
    if (!canManageLearningMaterials(access))
      return c.json(toErrorBody('FORBIDDEN','Material management is unavailable.'),403);
    const parsed=materialManagementInput.safeParse(await c.req.json().catch(()=>null));
    if (!parsed.success) return c.json(toErrorBody('VALIDATION_ERROR','Invalid material operation.'),400);
    const input=parsed.data;
    const scope=learningManagedMaterialScope(access,input.videoId);
    if (!scope) return c.json(toErrorBody('FORBIDDEN','Material management is unavailable.'),403);
    try {
      const result=await executeLearningMaterialOperation({
        execute:(scope,input)=>manageLtiMaterial(c.env,scope,input),
        process:taskId=>processExternalTaskById(c.env,taskId),
        dispatchDeferred:()=>{console.error(JSON.stringify({event:'lti_material_dispatch_deferred'}));},
      },{...scope,sessionProof:ltiSessionProof(grant,access.sessionHash),actorKey:await ltiSubjectKey(grant)},input);
      return c.json({material:result.material,reused:result.reused},result.pending?202:200);
    } catch(error) {
      if (error instanceof ApiError) return c.json(toErrorBody(error.code,error.expose?error.message:'Material management is unavailable.'),error.status);
      if (error instanceof LmsSyncError) return c.json(toErrorBody('FORBIDDEN','Material management is unavailable.'),403);
      console.error(JSON.stringify({event:'lti_material_operation_failed'}));
      return c.json(toErrorBody('INTERNAL_ERROR','Material management is unavailable.'),500);
    }
  });
}
