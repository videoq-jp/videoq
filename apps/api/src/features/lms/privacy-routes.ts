import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { decodeJwt, jwtVerify, type JWTVerifyGetKey } from 'jose';
import { z } from 'zod';
import { withClient } from '../../db/pool';
import type { AppEnv, Bindings } from '../../types/bindings';
import { ApiError, toErrorBody } from '../../shared/errors';
import { ltiConfig } from '../lti/config';
import { platformKeys } from '../lti/protocol';
import { digest } from '../lti/store';
import { erasePrivacyData, exportPrivacyPart, ORPHAN_CONTEXT, privacyCollections, privacyRequest, privacySubject,
  subjectPrivacyContexts, type PrivacyInstallation } from './privacy-data';

const claims=z.object({iss:z.string().min(1).max(2048),sub:z.string().min(1).max(255),aud:z.string().min(1).max(2200),
  deploymentId:z.string().min(1).max(255),iat:z.number().int(),exp:z.number().int(),jti:z.uuid(),
  version:z.literal(1),request:privacyRequest,
}).strict().refine(value=>value.exp>value.iat&&value.exp-value.iat<=120);
const unavailable=()=>new ApiError(403,'FORBIDDEN','Privacy request is unavailable.');
export async function verifyPrivacyAssertion(env:Bindings,assertion:string,keys?:JWTVerifyGetKey) {
  const config=ltiConfig(env);
  if(!config?.databaseRegistrations||config.privacyEnabled!==true)throw new ApiError(503,'PRIVACY_UNAVAILABLE','Privacy service is not enabled.');
  let hint:z.infer<typeof claims>;
  try {hint=claims.parse(decodeJwt(assertion));}catch{throw unavailable();}
  // Unknown issuers never select a network address. JWKS comes from the stored registration.
  const installation=await withClient(env,async client=>(await client.query<PrivacyInstallation&{jwksUrl:string}>(
    `SELECT id,owner_user_id AS "ownerUserId",issuer,client_id AS "clientId",deployment_id AS "deploymentId",jwks_url AS "jwksUrl"
      FROM lms_installations WHERE issuer=$1 AND client_id=$2 AND deployment_id=$3`,[hint.iss,hint.sub,hint.deploymentId])).rows[0]);
  if(!installation)throw unavailable();
  let verified:z.infer<typeof claims>;
  try {
    const result=await jwtVerify(assertion,keys??platformKeys(installation.jwksUrl),{
      issuer:installation.issuer,audience:config.toolOrigin+'/api/lms/privacy',algorithms:['RS256'],typ:'videoq-privacy+jwt',
      requiredClaims:['iat','exp','jti','sub'],clockTolerance:5,maxTokenAge:'2m',
    });
    verified=claims.parse(result.payload);
    if(verified.sub!==installation.clientId||verified.aud!==config.toolOrigin+'/api/lms/privacy'||verified.deploymentId!==installation.deploymentId)throw unavailable();
  }catch{throw unavailable();}
  const nonce=await digest(JSON.stringify(['lti-privacy-jti-v1',installation.id,verified.jti]));
  const accepted=await withClient(env,client=>client.query(`INSERT INTO lti_credentials(id,kind,payload,expires_at)
    VALUES($1,'lti-privacy-nonce',$2,$3) ON CONFLICT DO NOTHING RETURNING id`,
  [nonce,JSON.stringify({installationId:installation.id,action:verified.request.action}),new Date((verified.exp+60)*1000)]));
  if(accepted.rowCount!==1)throw unavailable();
  return {installation,request:verified.request};
}

export async function executePrivacyRequest(env:Bindings,installation:PrivacyInstallation,request:z.infer<typeof privacyRequest>) {
  return withClient(env,async client=>{
    await client.query('BEGIN');
    try {
      // This is recovery authority, independent of enrolment, quota or active connection state.
      const owner=await client.query(`SELECT id FROM users WHERE id=$1 FOR ${request.action==='erase'?'UPDATE':'SHARE'}`,[installation.ownerUserId]);
      const current=await client.query(`SELECT id FROM lms_installations WHERE id=$1 AND owner_user_id=$2 AND issuer=$3 AND client_id=$4 AND deployment_id=$5 FOR SHARE`,
      [installation.id,installation.ownerUserId,installation.issuer,installation.clientId,installation.deploymentId]);
      if(!owner.rowCount||!current.rowCount)throw unavailable();
      const legacy=await client.query(`SELECT 1 FROM lti_credentials WHERE kind='lti-history' AND expires_at>now()
        AND (payload->>'registrationId' IS NULL OR payload->>'subjectHash' IS NULL) LIMIT 1`);
      if(legacy.rowCount)throw new ApiError(503,'PRIVACY_UPGRADE_PENDING','Drain older API writers and expire legacy recent-history caches before enabling privacy requests.');
      let result:unknown;
      if(request.action==='catalog') {
        const contexts=await client.query<{context:string}>(`SELECT context FROM(
          SELECT context_id AS context FROM lms_courses WHERE installation_id=$1 UNION
          SELECT payload->>'contextId' FROM lti_credentials WHERE kind='lti-history' AND payload->>'registrationId'=$2
            AND payload->>'contextId' IS NOT NULL UNION SELECT $3::text) contexts WHERE context COLLATE "C">$4 ORDER BY context COLLATE "C" LIMIT 101`,
        [installation.id,'db:'+installation.id,ORPHAN_CONTEXT,request.after??'']);
        result={version:1,collections:privacyCollections,contexts:contexts.rows.slice(0,100).map(row=>row.context),
          nextAfter:contexts.rows.length>100?contexts.rows[99].context:null};
      } else if(request.action==='users') {
        const users:string[]=[];
        for(const raw of request.subjects) {
          const found=await subjectPrivacyContexts(client,installation,await privacySubject(installation,raw),'',request.contexts);
          if(found.contexts.length)users.push(raw);
        }
        result={subjects:users};
      } else {
        const subject=await privacySubject(installation,request.subject);
        result=request.action==='contexts'?await subjectPrivacyContexts(client,installation,subject,request.after):
          request.action==='export'?await exportPrivacyPart(client,installation,subject,request):
          {erased:await erasePrivacyData(client,installation,subject,request.contexts)};
      }
      await client.query('COMMIT');return result;
    }catch(error){await client.query('ROLLBACK');throw error;}
  });
}

/** Platform-signed, single-use purpose/audience-bound requests; never an LTI learner role. */
export const moodlePrivacyRoutes=new Hono<AppEnv>();
moodlePrivacyRoutes.use('*',bodyLimit({maxSize:65536}));
moodlePrivacyRoutes.post('/',async c=>{
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
