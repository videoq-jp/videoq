import type {CourseHistoryRepository,CourseHistoryScope} from '../contracts/course-history-repository';
import {checkHistoryScope,historyDenied} from '../../shared/course-history';
const safeJson=(column:string)=>`CASE WHEN json_valid(${column}) THEN ${column} ELSE '{}' END`;
function guard(scope:CourseHistoryScope,ownerUserId?:string){
 checkHistoryScope(scope);
 const proof=scope.sessionProof;if(!proof)return {sql:'1',values:[] as unknown[]};
 return {sql:`EXISTS(SELECT 1 FROM users owner JOIN lti_credentials session ON session.id=?
  WHERE owner.id=${ownerUserId===undefined?'(SELECT user_id FROM video_courses WHERE id=?)':'?'} AND session.kind='session'
   AND julianday(session.expires_at)>julianday('now') AND json_extract(session.payload,'$.registrationId')=? AND json_extract(session.payload,'$.subjectHash')=?)`,
  values:[proof.sessionHash,ownerUserId??scope.courseId,proof.registrationId,proof.subjectHash]};
}
const decode=(raw:string):unknown=>{try{return JSON.parse(raw) as unknown;}catch{return null;}};
export function createD1CourseHistoryRepository(database:D1Database):CourseHistoryRepository{return {
 async append(scope,id,turn,allowed,expiresAt){
  const authority=guard(scope),old=safeJson('lti_credentials.payload');
  const previous=`CASE WHEN julianday(lti_credentials.expires_at)>julianday('now')
   AND json_type(${old},'$.scopeVideoIds')='array' AND json_type(${old},'$.turns')='array'
   AND NOT EXISTS(SELECT 1 FROM json_each(${old},'$.scopeVideoIds') prior WHERE prior.type NOT IN('integer','real') OR prior.value<=0 OR prior.value>9007199254740991 OR prior.value<>CAST(prior.value AS INTEGER) OR
    NOT EXISTS(SELECT 1 FROM json_each(excluded.payload,'$.scopeVideoIds') next WHERE next.type='integer' AND next.value=prior.value))
   THEN ${old} -> '$.turns' ELSE '[]' END`;
  const recent=`(SELECT json_group_array(CASE WHEN type IN('array','object') THEN json(value) WHEN type='true' THEN json('true') WHEN type='false' THEN json('false') ELSE value END) FROM (SELECT value,type FROM (
   SELECT key,value,type FROM json_each(json_insert(${previous},'$[#]',json(excluded.payload -> '$.turns[0]')))
    ORDER BY CAST(key AS INTEGER) DESC LIMIT 50) ORDER BY CAST(key AS INTEGER)))`;
  const scopeJson=allowed===undefined?null:JSON.stringify([...new Set(allowed)].sort((a,b)=>a-b));
  const attribution={registrationId:scope.registrationId,subjectHash:scope.subjectHash,courseId:scope.courseId,...(scope.contextId?{contextId:scope.contextId}:{})};
  const result=await database.prepare(`WITH input AS (SELECT ? AS id,? AS attribution,coalesce(?,(
   SELECT json_group_array(video_id) FROM (SELECT DISTINCT video_id FROM video_course_members WHERE course_id=? ORDER BY video_id))) AS scope,? AS turn,? AS expiry)
   INSERT INTO lti_credentials(id,kind,payload,expires_at)
   SELECT id,'lti-history',json_set(json(attribution),'$.scopeVideoIds',json(scope),'$.turns',json_array(json(turn))),expiry FROM input WHERE ${authority.sql}
   ON CONFLICT(id) DO UPDATE SET expires_at=excluded.expires_at,payload=json_set(excluded.payload,'$.turns',json(${recent}))
    WHERE lti_credentials.kind='lti-history' RETURNING id`)
   .bind(id,JSON.stringify(attribution),scopeJson,scope.courseId,JSON.stringify(turn),expiresAt.toISOString(),...authority.values).first();
  if(!result)throw historyDenied();
 },
 async read(scope,id,ownerUserId){
  const authority=guard(scope,ownerUserId),payload=safeJson('h.payload');
  const result=await database.batch<Record<string,unknown>>([
   database.prepare(`SELECT (${authority.sql}) AS allowed`).bind(...authority.values),
   database.prepare(`SELECT h.payload,coalesce((SELECT json_group_array(json_object('id',l.id,'answer',l.response,'feedback',l.feedback))
    FROM chat_logs l WHERE l.user_id=? AND l.course_id=? AND l.id IN(SELECT json_extract(CASE WHEN turn.type='object' THEN turn.value ELSE '{}' END,'$.logId')
     FROM json_each(CASE WHEN json_type(${payload},'$.turns')='array' AND json_array_length(${payload},'$.turns')<=50
      THEN ${payload} -> '$.turns' ELSE '[]' END) turn
     WHERE json_type(CASE WHEN turn.type='object' THEN turn.value ELSE '{}' END,'$.logId') IN('integer','real'))),'[]') AS logs
    FROM lti_credentials h WHERE h.id=? AND h.kind='lti-history' AND julianday(h.expires_at)>julianday('now') AND ${authority.sql}`)
    .bind(ownerUserId,scope.courseId,id,...authority.values),
  ]);
  if(!result[0].results[0]?.allowed)throw historyDenied();
  const row=result[1].results[0] as {payload:string;logs:string}|undefined;if(!row)return null;
  const logs=JSON.parse(row.logs) as Array<{id:number;answer:string;feedback:string|null}>;
  return {payload:decode(row.payload),logs:logs.map(log=>({...log,id:Number(log.id),answer:decode(log.answer)}))};
 },
};}
