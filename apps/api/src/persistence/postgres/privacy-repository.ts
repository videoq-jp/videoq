import { privacyCatalogPage, privacySubjectsWithData, privacyHistoryNeedsUpgrade } from '../../application/privacy-policy';
import { PRIVACY_CONTEXT_PAGE_SIZE } from '../../application/privacy';
import { privacyStringLogic } from '../privacy-policy-sql';
import {withClient} from '../../db/pool';
import type {Bindings} from '../../types/bindings';
import type {PrivacyRepository} from '../contracts/privacy-repository';
import {ORPHAN_CONTEXT,privacySubject,assertPrivacyRecovery} from '../../shared/privacy';
import {subjectPrivacyContexts,exportPrivacyPart,erasePrivacyData} from './privacy-data';
export function createPostgresPrivacyRepository(env:Bindings):PrivacyRepository{return {async execute(installation,request){
  return withClient(env,async client=>{
    await client.query('BEGIN');
    try {
      const identity=await client.query(`SELECT id FROM lms_installations WHERE id=$1 AND owner_user_id=$2 AND issuer=$3 AND client_id=$4 AND deployment_id=$5 AND ($6::text IS NULL OR jwks_url=$6)`,
        [installation.id,installation.ownerUserId,installation.issuer,installation.clientId,installation.deploymentId,installation.jwksUrl??null]);
      assertPrivacyRecovery(Boolean(identity.rowCount));
      // This is recovery authority, independent of enrolment, quota or active connection state.
      const owner=await client.query(`SELECT id FROM users WHERE id IN(
        SELECT $3::text UNION SELECT owner_user_id FROM teaching_connections WHERE provider='moodle' AND installation_id=$1
        UNION SELECT DISTINCT l.user_id FROM chat_logs l JOIN lti_chat_log_subjects s ON s.chat_log_id=l.id
          WHERE s.subject_key IN(SELECT subject_key FROM lti_chat_log_subjects WHERE registration_id=$2)
      ) ORDER BY id FOR ${request.action==='erase'?'UPDATE':'SHARE'}`,[installation.id,'db:'+installation.id,installation.ownerUserId]);
      const current=await client.query(`SELECT id FROM lms_installations WHERE id=$1 AND owner_user_id=$2 AND issuer=$3 AND client_id=$4 AND deployment_id=$5 AND ($6::text IS NULL OR jwks_url=$6) FOR SHARE`,
      [installation.id,installation.ownerUserId,installation.issuer,installation.clientId,installation.deploymentId,installation.jwksUrl??null]);
      assertPrivacyRecovery(Boolean(owner.rowCount)&&Boolean(current.rowCount));
      const legacy=await client.query(`SELECT 1 FROM lti_credentials WHERE kind='lti-history' AND ${privacyHistoryNeedsUpgrade('expires_at>now()',"payload->>'registrationId' IS NULL","payload->>'subjectHash' IS NULL",privacyStringLogic)} LIMIT 1`);
      assertPrivacyRecovery(true,!legacy.rowCount);
      let result:unknown;
      if(request.action==='catalog') {
        const contexts=await client.query<{context:string}>(`SELECT context FROM(
          SELECT context_id AS context FROM lms_courses WHERE installation_id=$1 UNION
          SELECT context_id FROM teaching_connections WHERE provider='moodle' AND installation_id=$1 UNION
          SELECT payload->>'contextId' FROM lti_credentials WHERE kind='lti-history' AND payload->>'registrationId'=$2
            AND payload->>'contextId' IS NOT NULL UNION SELECT $3::text) contexts WHERE context COLLATE "C">$4 ORDER BY context COLLATE "C" LIMIT ${PRIVACY_CONTEXT_PAGE_SIZE+1}`,
        [installation.id,'db:'+installation.id,ORPHAN_CONTEXT,request.after??'']);
        result=privacyCatalogPage(contexts.rows,row=>row.context);
      } else if(request.action==='users') {
        const matches:boolean[]=[];
        for(const raw of request.subjects) {
          const found=await subjectPrivacyContexts(client,installation,await privacySubject(installation,raw),'',request.contexts);
          matches.push(found.contexts.length>0);
        }
        result={subjects:privacySubjectsWithData(request.subjects,matches)};
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
