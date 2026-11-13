import {withDb} from '../../db/pool';
import {lockLmsGrant} from './lms-resource-repository';
import {lockLtiDataSessionWithDb} from './lti-session-lock';
import type {Bindings} from '../../types/bindings';
import type {CourseReportRepository,ReportDay} from '../contracts/course-report-repository';
import {reportDenied as denied,checkCourseReport} from '../../shared/course-report';
import {digest} from '../../features/lti/store';
export function createPostgresCourseReportRepository(env:Bindings):CourseReportRepository{return {async summarize(scope,input,actorKey){
 checkCourseReport(scope,input);
  return withDb(env, async (db, client) => {
    await client.query('BEGIN');
    try {
      await client.query("SET LOCAL statement_timeout='5s'; SET LOCAL lock_timeout='500ms'");
      await lockLmsGrant(db, { id: scope.installationId, ownerUserId: scope.ownerUserId },scope.contextId,scope.courseId);
      await lockLtiDataSessionWithDb(db, scope.ownerUserId, scope.sessionProof);
      const session = await client.query(`SELECT id FROM lti_credentials WHERE id=$1
        AND payload->>'contextId'=$2 AND payload->>'courseId'=$3`, [scope.sessionProof.sessionHash, scope.contextId, String(scope.courseId)]);
      if (session.rowCount !== 1) throw denied();
      const course = await client.query(`SELECT c.id FROM lms_courses c JOIN video_courses v ON v.id=c.course_id
        WHERE c.installation_id=$1 AND c.context_id=$2 AND c.course_id=$3 AND v.user_id=$4
          AND v.managed_by_lms=true FOR SHARE OF c,v`, [scope.installationId, scope.contextId, scope.courseId, scope.ownerUserId]);
      if (course.rowCount !== 1) throw denied();
      const resources = await client.query<{ video_id: string }>(`SELECT r.video_id FROM lms_resources r
        JOIN video_course_members m ON m.course_id=r.course_id AND m.video_id=r.video_id
        JOIN videos v ON v.id=r.video_id AND v.user_id=$4 AND v.managed_by_lms=true AND v.status='completed'
        JOIN jsonb_to_recordset($5::jsonb) AS granted("videoId" bigint,generation bigint,"resourceLinkId" text)
          ON granted."videoId"=r.video_id AND granted.generation=r.generation AND granted."resourceLinkId"=r.resource_link_id
        WHERE r.installation_id=$1 AND r.context_id=$2 AND r.course_id=$3 AND r.enabled=true FOR SHARE OF r,m,v`,
      [scope.installationId, scope.contextId, scope.courseId, scope.ownerUserId, JSON.stringify(scope.readable)]);
      const ids = [...new Set(resources.rows.map(row => Number(row.video_id)))].sort((a, b) => a - b);
      const days = await client.query<ReportDay>(`SELECT (l.created_at AT TIME ZONE 'UTC')::date::text AS date,
        count(*)::int AS questions,count(*) FILTER(WHERE l.feedback='good')::int AS good,
        count(*) FILTER(WHERE l.feedback='bad')::int AS bad,count(*) FILTER(WHERE l.feedback IS NULL)::int AS none
        FROM chat_logs l JOIN lti_chat_log_subjects s ON s.chat_log_id=l.id
        WHERE l.user_id=$1 AND l.course_id=$2 AND s.registration_id=$3 AND s.context_id=$4
          AND l.created_at >= $5::date AT TIME ZONE 'UTC' AND l.created_at < ($6::date + 1) AT TIME ZONE 'UTC'
          AND jsonb_array_length(s.resource_video_ids)>0 AND s.resource_video_ids <@ $7::jsonb
          AND jsonb_typeof(l.response)='object' AND jsonb_typeof(l.response->'sources')='array'
          AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(l.response->'sources')='array'
            THEN l.response->'sources' ELSE '[]'::jsonb END) source
            WHERE NOT ($7::jsonb @> jsonb_build_array(source->'video_id')))
        GROUP BY (l.created_at AT TIME ZONE 'UTC')::date ORDER BY date`,
      [scope.ownerUserId, scope.courseId, 'db:' + scope.installationId, scope.contextId, input.from, input.to, JSON.stringify(ids)]);
      await client.query(`INSERT INTO lti_report_accesses(installation_id,course_id,context_id,actor_key,from_date,to_date,resource_count,scope_hash)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, [scope.installationId, scope.courseId, scope.contextId, actorKey,
        input.from, input.to, ids.length, await digest(JSON.stringify(ids))]);
      await client.query('COMMIT');
      return days.rows;
    } catch (error) { await client.query('ROLLBACK'); throw error; }
  });
}};}
