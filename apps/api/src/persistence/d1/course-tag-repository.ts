import type {CourseTagRepository,CourseTagScope,CourseTag} from '../contracts/course-tag-repository';
import {tagDenied,tagConflict,assignmentRevision,visible,requireManagedVideos,refineTagScope,tagCatalog,checkCourseTags,type TagResource} from '../../shared/course-tags';
import {ApiError} from '../../shared/errors';
import {digest} from '../../features/lti/store';
import {operationReservationKey} from '../../shared/lti-operation-key';
const TAGS=`(SELECT json_group_array(json_object('id',t.id,'name',t.name,'color',t.color,'revision',t.revision,'video_ids',json((
 SELECT json_group_array(CAST(video_id AS TEXT)) FROM (SELECT video_id FROM lti_course_video_tags WHERE tag_id=t.id ORDER BY video_id)))))
 FROM (SELECT id,name,color,revision FROM lti_course_tags WHERE course_id=? ORDER BY name,id LIMIT 201) t)`;
const RESOURCES=`(SELECT json_group_array(json_object('video_id',r.video_id,'resource_link_id',r.resource_link_id,'generation',r.generation,'status',r.status)) FROM (
 SELECT r.id,r.video_id,r.resource_link_id,r.generation,v.status FROM lms_resources r
 JOIN video_course_members m ON m.video_id=r.video_id AND m.course_id=r.course_id JOIN videos v ON v.id=r.video_id AND v.managed_by_lms=1
 WHERE r.installation_id=? AND r.context_id=? AND r.course_id=? AND v.user_id=? AND r.enabled=1 AND r.video_id IN(SELECT value FROM json_each(?)) ORDER BY r.id) r)`;
function authority(scope:CourseTagScope){
 const proof=scope.sessionProof;
 return {sql:`EXISTS(SELECT 1 FROM lms_installations i JOIN lms_courses c ON c.installation_id=i.id JOIN teaching_connections t ON t.provider='moodle' AND t.installation_id=i.id AND t.context_id=c.context_id AND t.course_id=c.course_id AND t.active=1 JOIN users owner ON owner.id=t.owner_user_id JOIN video_courses v ON v.id=c.course_id
  WHERE i.id=? AND owner.id=? AND i.active=1 AND owner.is_active=1 AND owner.deactivated_at IS NULL
   AND (owner.banned IS NOT TRUE OR julianday(owner.ban_expires)<=julianday('now')) AND c.context_id=? AND c.course_id=? AND v.user_id=owner.id AND v.managed_by_lms=1
   ${proof?`AND EXISTS(SELECT 1 FROM lti_credentials s WHERE s.id=? AND s.kind='session' AND julianday(s.expires_at)>julianday('now') AND json_extract(s.payload,'$.registrationId')=? AND json_extract(s.payload,'$.subjectHash')=?)`:''})`,
  values:[scope.installationId,scope.ownerUserId,scope.contextId,scope.courseId,...(proof?[proof.sessionHash,proof.registrationId,proof.subjectHash]:[])]};
}
export function createD1CourseTagRepository(database:D1Database):CourseTagRepository{return {async execute(original,input){
 checkCourseTags(original,input);
 const auth=authority(original),candidates=[...new Set([...original.readableVideoIds,...original.management.map(r=>r.videoId)])];
 const resourceArgs=[original.installationId,original.contextId,original.courseId,original.ownerUserId,JSON.stringify(candidates)];
 const operationId=input.action==='list'?'':input.operationId.toLowerCase();
 const hash=input.action==='list'?'':await digest(JSON.stringify(input)),key=await operationReservationKey('tag',operationId);
 const prepare=(sql:string,args:unknown[]=[])=>database.prepare(sql).bind(...args);
 for(let retry=0;retry<5;retry++){
  const snapshot=await database.batch<Record<string,unknown>>([
   prepare(`SELECT (${auth.sql}) AS allowed`,auth.values),
   prepare(`SELECT ${RESOURCES} AS resources`,resourceArgs),
   prepare(`SELECT ${TAGS} AS tags`,[original.courseId]),
   prepare('SELECT course_id,actor_key,request_hash FROM lti_course_tag_operations WHERE id=?',[operationId]),
   prepare('SELECT key FROM lti_operation_reservations WHERE key=?',[key]),
  ]);
  if(!snapshot[0].results[0]?.allowed)throw tagDenied();
  const rawResources=String(snapshot[1].results[0].resources),rawTags=String(snapshot[2].results[0].tags);
  const scope=refineTagScope(original,JSON.parse(rawResources) as TagResource[]),all=JSON.parse(rawTags) as CourseTag[];
  if(input.action==='list')return tagCatalog(all,scope);
  if(all.length>200)throw new ApiError(413,'VALIDATION_ERROR','Too many course tags.');
  const prior=snapshot[3].results[0];
  if(prior){if(Number(prior.course_id)!==scope.courseId||prior.actor_key!==scope.actorKey||prior.request_hash!==hash)throw tagConflict();}
  else{
   if(snapshot[4].results.length)throw tagConflict('This operation is no longer available. Refresh and start a new operation.');
   if(input.action==='create'){
    if(all.length>=200)throw new ApiError(413,'VALIDATION_ERROR','Too many course tags.');
   }else if(input.action==='assign'){
    requireManagedVideos(scope,[input.videoId]);
    if(input.tagIds.some(id=>!all.some(tag=>tag.id===id&&visible(tag,scope))))throw tagDenied();
    const ids=all.filter(t=>t.video_ids.includes(String(input.videoId))).map(t=>t.id);
    if(await assignmentRevision(scope,input.videoId,ids)!==input.revision)throw tagConflict();
   }else{
    const tag=all.find(t=>t.id===input.id&&visible(t,scope));if(!tag)throw tagDenied();
    requireManagedVideos(scope,tag.video_ids.map(Number));if(tag.revision!==input.revision)throw tagConflict();
   }
  }
  const token=crypto.randomUUID(),gate='EXISTS(SELECT 1 FROM mutation_receipts WHERE token=?)';
  const operationGuard=prior?`EXISTS(SELECT 1 FROM lti_course_tag_operations WHERE id=? AND course_id=? AND actor_key=? AND request_hash=?)`
   :`NOT EXISTS(SELECT 1 FROM lti_course_tag_operations WHERE id=?) AND NOT EXISTS(SELECT 1 FROM lti_operation_reservations WHERE key=?)`;
  const statements=[
   prepare(`INSERT INTO mutation_receipts(token,kind,resource_id) SELECT ?,'lti_tag',0 WHERE ${auth.sql} AND ${RESOURCES}=? AND ${TAGS}=? AND ${operationGuard}`,
    [token,...auth.values,...resourceArgs,rawResources,scope.courseId,rawTags,...(prior?[operationId,scope.courseId,scope.actorKey,hash]:[operationId,key])]),
   prepare(`INSERT INTO lti_operation_reservations(key) SELECT ? WHERE ${gate} ON CONFLICT DO NOTHING`,[key,token]),
  ];
  if(!prior){
   if(input.action==='create')statements.push(prepare(`INSERT INTO lti_course_tags(id,course_id,name,color,revision) SELECT ?,?,?,?,? WHERE ${gate}`,[operationId,scope.courseId,input.name,input.color,crypto.randomUUID(),token]));
   else if(input.action==='assign')statements.push(
    prepare(`DELETE FROM lti_course_video_tags WHERE video_id=? AND tag_id IN(SELECT id FROM lti_course_tags WHERE course_id=?) AND ${gate}`,[input.videoId,scope.courseId,token]),
    prepare(`INSERT INTO lti_course_video_tags(tag_id,video_id) SELECT value,? FROM json_each(?) WHERE ${gate}`,[input.videoId,JSON.stringify(input.tagIds),token]));
   else if(input.action==='delete')statements.push(prepare(`DELETE FROM lti_course_tags WHERE id=? AND course_id=? AND ${gate}`,[input.id,scope.courseId,token]));
   else statements.push(prepare(`UPDATE lti_course_tags SET name=?,color=?,revision=? WHERE id=? AND course_id=? AND ${gate}`,[input.name,input.color,crypto.randomUUID(),input.id,scope.courseId,token]));
   statements.push(prepare(`INSERT INTO lti_course_tag_operations(id,course_id,actor_key,action,request_hash) SELECT ?,?,?,?,? WHERE ${gate}`,[operationId,scope.courseId,scope.actorKey,input.action,hash,token]));
  }
  const output=statements.length;
  statements.push(prepare(`SELECT ${TAGS} AS tags WHERE ${gate}`,[scope.courseId,token]),prepare('DELETE FROM mutation_receipts WHERE token=?',[token]));
  let result:D1Result<Record<string,unknown>>[];
  try{result=await database.batch<Record<string,unknown>>(statements);}catch(error){if(String(error).includes('UNIQUE constraint failed'))throw tagConflict();throw error;}
  const row=result[output].results[0];if(row)return tagCatalog(JSON.parse(String(row.tags)) as CourseTag[],scope,Boolean(prior));
 }
 throw tagConflict();
}};}
