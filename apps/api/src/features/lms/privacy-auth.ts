import {decodeJwt,jwtVerify,type JWTVerifyGetKey} from 'jose';
import {z} from 'zod';
import {createPrivacyAuthorizationRepository} from '../../persistence/factory';
import {privacyRequest} from '../../shared/privacy';
import {ApiError} from '../../shared/errors';
import {ltiConfig} from '../lti/config';
import {platformKeys} from '../lti/protocol';
import {digest} from '../lti/store';
import type {Bindings} from '../../types/bindings';
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
  const repository=await createPrivacyAuthorizationRepository(env);
  const installation=await repository.findInstallation({issuer:hint.iss,clientId:hint.sub,deploymentId:hint.deploymentId});
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
  const accepted=await repository.consumeNonce(installation,nonce,verified.request.action,new Date((verified.exp+60)*1000));
  if(!accepted)throw unavailable();
  return {installation,request:verified.request};
}

