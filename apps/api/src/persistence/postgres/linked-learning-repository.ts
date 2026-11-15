import { withClient } from '../../db/pool';
import type { Bindings } from '../../types/bindings';

import type {LinkedLearningRepository} from '../contracts/linked-learning-repository';

/** Fresh owner, connection, course and playable members in one database lease.
 * No credentials or permission results survive the current request.
 */
export function createPostgresLinkedLearningRepository(env:Bindings):LinkedLearningRepository {
 return {async findCourse(installationId,contextId){
  return withClient(env, async client => {
    const { rows } = await client.query<{
      courseId: string; ownerUserId: string; teacherSubject: string; resourceLinkId: string | null;
      courseTitle: string; videoId: string | null; videoTitle: string | null;
    }>(`SELECT c.id AS "courseId", c.user_id AS "ownerUserId", t.teacher_subject AS "teacherSubject",
        t.resource_link_id AS "resourceLinkId", c.name AS "courseTitle", v.id AS "videoId", v.title AS "videoTitle"
      FROM teaching_connections t
      JOIN video_courses c ON c.id=t.course_id AND c.user_id=t.owner_user_id AND c.native_access_disabled=false
      JOIN users u ON u.id=c.user_id AND u.is_active=true AND u.deactivated_at IS NULL
        AND (u.banned IS NOT TRUE OR u.ban_expires<=now())
      LEFT JOIN video_course_members m ON m.course_id=c.id
      LEFT JOIN videos v ON v.id=m.video_id AND v.user_id=c.user_id AND v.status='completed'
      WHERE t.provider='moodle' AND t.installation_id=$1 AND t.context_id=$2 AND t.active=true
      ORDER BY m."order",m.id`, [installationId, contextId]);
    if (!rows.length) return null;
    const row = rows[0];
    return { courseId: Number(row.courseId), ownerUserId: row.ownerUserId, teacherSubject: row.teacherSubject,
      resourceLinkId: row.resourceLinkId, courseTitle: row.courseTitle,
      videos: rows.flatMap(item => item.videoId === null ? [] : [{ videoId: Number(item.videoId),
        lesson: String(item.videoId), title: item.videoTitle || row.courseTitle }]) };
  });
 }};
}
