import type {CourseReportRepository,ReportDay} from '../contracts/course-report-repository';
import {checkCourseReport,reportDenied} from '../../shared/course-report';
import {digest} from '../../features/lti/store';
const IDS=`(SELECT json_group_array(video_id) FROM (SELECT DISTINCT r.video_id FROM lms_resources r
 JOIN video_course_members m ON m.course_id=r.course_id AND m.video_id=r.video_id
 JOIN videos v ON v.id=r.video_id AND v.user_id=? AND v.managed_by_lms=1 AND v.status='completed'
 JOIN json_each(?) granted ON json_extract(granted.value,'$.videoId')=r.video_id
  AND json_extract(granted.value,'$.generation')=r.generation AND json_extract(granted.value,'$.resourceLinkId')=r.resource_link_id
 WHERE r.installation_id=? AND r.context_id=? AND r.course_id=? AND r.enabled=1 ORDER BY r.video_id))`;
const AUTHORITY=`EXISTS(SELECT 1 FROM lms_installations i JOIN lms_courses c ON c.installation_id=i.id JOIN teaching_connections t ON t.provider='moodle' AND t.installation_id=i.id AND t.context_id=c.context_id AND t.course_id=c.course_id AND t.active=1 JOIN users owner ON owner.id=t.owner_user_id JOIN video_courses v ON v.id=c.course_id
 JOIN lti_credentials session ON session.id=? WHERE i.id=? AND owner.id=? AND i.active=1
 AND owner.is_active=1 AND owner.deactivated_at IS NULL AND (owner.banned IS NOT TRUE OR julianday(owner.ban_expires)<=julianday('now'))
 AND c.context_id=? AND c.course_id=? AND v.user_id=owner.id AND v.managed_by_lms=1
 AND session.kind='session' AND julianday(session.expires_at)>julianday('now')
 AND json_extract(session.payload,'$.registrationId')=? AND json_extract(session.payload,'$.subjectHash')=?
 AND json_extract(session.payload,'$.contextId')=c.context_id AND json_extract(session.payload,'$.courseId')=c.course_id)`;
const safeJson=(raw:string)=>`CASE WHEN json_valid(${raw}) THEN ${raw} ELSE '{}' END`;
const response=safeJson('l.response'),original=safeJson('s.resource_video_ids');
const source=`CASE WHEN source.type='object' THEN source.value ELSE '{}' END`;
export function createD1CourseReportRepository(database:D1Database):CourseReportRepository{return {async summarize(scope,input,actorKey){
 checkCourseReport(scope,input);
 const idsArgs=[scope.ownerUserId,JSON.stringify(scope.readable),scope.installationId,scope.contextId,scope.courseId];
 const authArgs=[scope.sessionProof.sessionHash,scope.installationId,scope.ownerUserId,scope.contextId,scope.courseId,scope.sessionProof.registrationId,scope.sessionProof.subjectHash];
 for(let retry=0;retry<5;retry++){
  const ids=await database.prepare(`SELECT ${IDS} AS ids`).bind(...idsArgs).first<string>('ids');
  if(!ids)throw reportDenied();
  const auditId=crypto.randomUUID(),scopeHash=await digest(ids),count=(JSON.parse(ids) as number[]).length;
  // The audit is the receipt. No aggregate can leave this batch unless the
  // current authority and sorted resource IDs still match the prepared scope.
  const result=await database.batch<Record<string,unknown>>([
   database.prepare(`INSERT INTO lti_report_accesses(id,installation_id,course_id,context_id,actor_key,from_date,to_date,resource_count,scope_hash)
    SELECT ?,?,?,?,?,?,?,?,? WHERE ${AUTHORITY} AND ${IDS}=?`)
    .bind(auditId,scope.installationId,scope.courseId,scope.contextId,actorKey,input.from,input.to,count,scopeHash,...authArgs,...idsArgs,ids),
   database.prepare(`SELECT date(l.created_at) AS date,count(*) AS questions,
    count(*) FILTER(WHERE l.feedback='good') AS good,count(*) FILTER(WHERE l.feedback='bad') AS bad,count(*) FILTER(WHERE l.feedback IS NULL) AS none
    FROM chat_logs l JOIN lti_chat_log_subjects s ON s.chat_log_id=l.id
    WHERE EXISTS(SELECT 1 FROM lti_report_accesses WHERE id=?) AND l.user_id=? AND l.course_id=? AND s.registration_id=? AND s.context_id=?
     AND julianday(l.created_at)>=julianday(?) AND julianday(l.created_at)<julianday(?,'+1 day')
     AND json_type(${original})='array' AND json_array_length(${original})>0
     AND NOT EXISTS(SELECT 1 FROM json_each(${original}) prior WHERE prior.type NOT IN('integer','real')
      OR NOT EXISTS(SELECT 1 FROM json_each(?) granted WHERE granted.value=prior.value))
     AND json_type(${response})='object' AND json_type(${response},'$.sources')='array'
     AND NOT EXISTS(SELECT 1 FROM json_each(CASE WHEN json_type(${response},'$.sources')='array' THEN ${response}->'$.sources' ELSE '[]' END) source
      WHERE json_type(${source},'$.video_id') IS NULL OR json_type(${source},'$.video_id') NOT IN('integer','real')
       OR NOT EXISTS(SELECT 1 FROM json_each(?) granted WHERE granted.value=json_extract(${source},'$.video_id')))
    GROUP BY date(l.created_at) ORDER BY date`)
    .bind(auditId,scope.ownerUserId,scope.courseId,scope.sessionProof.registrationId,scope.contextId,input.from,input.to,ids,ids),
   database.prepare(`SELECT (${AUTHORITY}) AS allowed`).bind(...authArgs),
  ]);
  if(result[0].meta.changes===1)return result[1].results.map(row=>({date:String(row.date),questions:Number(row.questions),good:Number(row.good),bad:Number(row.bad),none:Number(row.none)} satisfies ReportDay));
  if(!result[2].results[0]?.allowed)throw reportDenied();
 }
 throw reportDenied();
}};}
