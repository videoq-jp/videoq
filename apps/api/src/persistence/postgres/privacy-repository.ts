import {withClient} from '../../db/pool';
import {ApiError} from '../../shared/errors';
import type {Bindings} from '../../types/bindings';
import type {PrivacyRepository} from '../contracts/privacy-repository';
import {ORPHAN_CONTEXT,privacyCollections,privacySubject} from '../../shared/privacy';
import {subjectPrivacyContexts,exportPrivacyPart,erasePrivacyData} from './privacy-data';
const unavailable=()=>new ApiError(403,'FORBIDDEN','Privacy request is unavailable.');
export function createPostgresPrivacyRepository(env:Bindings):PrivacyRepository{return {async execute(installation,request){
  return withClient(env,async client=>{
    await client.query('BEGIN');
    try {
      const identity=await client.query(`SELECT id FROM lms_installations WHERE id=$1 AND owner_user_id=$2 AND issuer=$3 AND client_id=$4 AND deployment_id=$5 AND ($6::text IS NULL OR jwks_url=$6)`,
        [installation.id,installation.ownerUserId,installation.issuer,installation.clientId,installation.deploymentId,installation.jwksUrl??null]);
      if(!identity.rowCount)throw unavailable();
      // This is recovery authority, independent of enrolment, quota or active connection state.
      const owner=await client.query(`SELECT id FROM users WHERE id IN(
        SELECT $3::text UNION SELECT owner_user_id FROM teaching_connections WHERE provider='moodle' AND installation_id=$1
        UNION SELECT DISTINCT l.user_id FROM chat_logs l JOIN lti_chat_log_subjects s ON s.chat_log_id=l.id
          WHERE s.subject_key IN(SELECT subject_key FROM lti_chat_log_subjects WHERE registration_id=$2)
      ) ORDER BY id FOR ${request.action==='erase'?'UPDATE':'SHARE'}`,[installation.id,'db:'+installation.id,installation.ownerUserId]);
      const current=await client.query(`SELECT id FROM lms_installations WHERE id=$1 AND owner_user_id=$2 AND issuer=$3 AND client_id=$4 AND deployment_id=$5 AND ($6::text IS NULL OR jwks_url=$6) FOR SHARE`,
      [installation.id,installation.ownerUserId,installation.issuer,installation.clientId,installation.deploymentId,installation.jwksUrl??null]);
      if(!owner.rowCount||!current.rowCount)throw unavailable();
      const legacy=await client.query(`SELECT 1 FROM lti_credentials WHERE kind='lti-history' AND expires_at>now()
        AND (payload->>'registrationId' IS NULL OR payload->>'subjectHash' IS NULL) LIMIT 1`);
      if(legacy.rowCount)throw new ApiError(503,'PRIVACY_UPGRADE_PENDING','Drain older API writers and expire legacy recent-history caches before enabling privacy requests.');
      let result:unknown;
      if(request.action==='catalog') {
        const contexts=await client.query<{context:string}>(`SELECT context FROM(
          SELECT context_id AS context FROM lms_courses WHERE installation_id=$1 UNION
          SELECT context_id FROM teaching_connections WHERE provider='moodle' AND installation_id=$1 UNION
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
}};}
