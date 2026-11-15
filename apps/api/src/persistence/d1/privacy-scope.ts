import {ApiError} from '../../shared/errors';
import {digest} from '../../features/lti/store';
import type {PrivacySubject,PrivacyInstallation} from '../../shared/privacy';
const COURSES="(SELECT json_group_array(id) FROM(SELECT CAST(id AS TEXT) AS id FROM video_courses ORDER BY video_courses.id))";
const AUTH=`EXISTS(SELECT 1 FROM lms_installations i JOIN users owner ON owner.id=i.owner_user_id WHERE i.id=p.installation AND owner.id=p.owner
 AND i.issuer=p.issuer AND i.client_id=p.client AND i.deployment_id=p.deployment AND (p.jwks IS NULL OR i.jwks_url=p.jwks))`;
const UPGRADED=`NOT EXISTS(SELECT 1 FROM lti_credentials WHERE kind='lti-history' AND julianday(expires_at)>julianday('now')
 AND (json_extract(payload,'$.registrationId') IS NULL OR json_extract(payload,'$.subjectHash') IS NULL))`;
const PARAMS=`WITH params AS(SELECT ? owner,? subject,? registration,? subject_hash,? installation,? contexts,? authors,? expected_courses,? issuer,? client,? deployment,? jwks)`;
const CTE=PARAMS+`,eligible AS(SELECT * FROM params p WHERE ${AUTH} AND ${UPGRADED} AND ${COURSES}=p.expected_courses)`;
const unavailable=()=>new ApiError(403,'FORBIDDEN','Privacy request is unavailable.');
const upgrade=()=>new ApiError(503,'PRIVACY_UPGRADE_PENDING','Drain older API writers and expire legacy recent-history caches before enabling privacy requests.');
export async function prepareD1PrivacyScope(database:D1Database,installation:PrivacyInstallation,subjects:PrivacySubject[],contexts:string[]|null){
   const ids=(await database.prepare('SELECT CAST(id AS TEXT) AS id FROM video_courses ORDER BY video_courses.id').all<{id:string}>()).results.map(r=>r.id);
   if(ids.some(id=>!Number.isSafeInteger(Number(id))))throw new ApiError(503,'PRIVACY_UPGRADE_PENDING','Course identifiers require migration.');
   const authors=new Map<string,string>();
   // Bound crypto concurrency even for users requests covering many subjects/courses.
   for(const s of subjects){
    const entries:Array<{id:number;author:string}>=[];
    for(let offset=0;offset<ids.length;offset+=100)entries.push(...await Promise.all(ids.slice(offset,offset+100).map(async id=>({id:Number(id),author:await digest(JSON.stringify(['lti-course-qa-v1',s.registrationId,s.subjectHash,Number(id)]))}))));
    authors.set(s.subjectKey,JSON.stringify(entries));
   }
 const params=(s:PrivacySubject)=>[installation.ownerUserId,s.subjectKey,s.registrationId,s.subjectHash,installation.id,contexts?JSON.stringify(contexts):null,authors.get(s.subjectKey)??'[]',JSON.stringify(ids),installation.issuer,installation.clientId,installation.deploymentId,installation.jwksUrl??null];
 const query=(s:PrivacySubject,sql:string,args:unknown[]=[])=>database.prepare(CTE+' '+sql).bind(...params(s),...args);
 return {query,check:()=>database.prepare(PARAMS+` SELECT (${AUTH}) AS allowed,(${UPGRADED}) AS upgraded,(${COURSES}=p.expected_courses) AS stable FROM params p`).bind(...params(subjects[0]))};
}
export function checkD1PrivacyScope(row:Record<string,unknown>):boolean{
 if(!row.allowed)throw unavailable();if(!row.upgraded)throw upgrade();return Boolean(row.stable);
}
