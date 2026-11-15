import {withClient} from '../../db/pool';
import type {Bindings} from '../../types/bindings';
import type {PrivacyAuthorizationRepository,PrivacyRegistration} from '../contracts/privacy-authorization-repository';
export function createPostgresPrivacyAuthorizationRepository(env:Bindings):PrivacyAuthorizationRepository{return {
 findInstallation:identity=>withClient(env,async client=>(await client.query<PrivacyRegistration>(`SELECT id,owner_user_id AS "ownerUserId",issuer,client_id AS "clientId",deployment_id AS "deploymentId",jwks_url AS "jwksUrl"
  FROM lms_installations WHERE issuer=$1 AND client_id=$2 AND deployment_id=$3`,[identity.issuer,identity.clientId,identity.deploymentId])).rows[0]??null),
 consumeNonce:(r,nonce,action,expiresAt)=>withClient(env,async client=>{
  const result=await client.query(`INSERT INTO lti_credentials(id,kind,payload,expires_at)
   SELECT $1,'lti-privacy-nonce',$2::jsonb,$3::timestamptz FROM lms_installations i JOIN users owner ON owner.id=i.owner_user_id
   WHERE i.id=$4 AND i.owner_user_id=$5 AND i.issuer=$6 AND i.client_id=$7 AND i.deployment_id=$8 AND i.jwks_url=$9
    AND $3::timestamptz>clock_timestamp() ON CONFLICT DO NOTHING RETURNING id`,[nonce,JSON.stringify({installationId:r.id,action}),expiresAt,r.id,r.ownerUserId,r.issuer,r.clientId,r.deploymentId,r.jwksUrl]);
  return result.rowCount===1;
 }),
};}
