import {Hono} from 'hono';
import {bodyLimit} from 'hono/body-limit';
import {z} from 'zod';
import type {AppEnv,Bindings} from '../../types/bindings';
import {ApiError,toErrorBody} from '../../shared/errors';
import {privacyRequest,type PrivacyInstallation} from '../../shared/privacy';
import {createPrivacyRepository} from '../../persistence/factory';
import {verifyPrivacyAssertion} from './privacy-auth';
export {verifyPrivacyAssertion} from './privacy-auth';
export async function executePrivacyRequest(env:Bindings,installation:PrivacyInstallation,request:z.infer<typeof privacyRequest>){
 return (await createPrivacyRepository(env)).execute(installation,request);
}

/** Platform-signed, single-use purpose/audience-bound requests; never an LTI learner role. */
export const lmsPrivacyRoutes=new Hono<AppEnv>();
lmsPrivacyRoutes.use('*',bodyLimit({maxSize:65536}));
lmsPrivacyRoutes.post('/',async c=>{
  c.header('Cache-Control','private, no-store');
  const input=z.object({assertion:z.string().min(1).max(60000)}).strict().safeParse(await c.req.json().catch(()=>null));
  if(!input.success)return c.json(toErrorBody('FORBIDDEN','Privacy request is unavailable.'),403);
  try {
    const verified=await verifyPrivacyAssertion(c.env,input.data.assertion);
    return c.json(await executePrivacyRequest(c.env,verified.installation,verified.request));
  }catch(error){
    if(error instanceof ApiError)return c.json(toErrorBody(error.code,error.expose?error.message:'Privacy request is unavailable.'),error.status);
    console.error(JSON.stringify({event:'lti_privacy_request_failed'}));
    return c.json(toErrorBody('INTERNAL_ERROR','Privacy request is unavailable.'),500);
  }
});

// Compatibility name for existing integrations/tests.
export { lmsPrivacyRoutes as moodlePrivacyRoutes };
