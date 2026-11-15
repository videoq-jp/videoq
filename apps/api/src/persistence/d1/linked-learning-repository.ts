import type {LinkedLearningRepository} from '../contracts/linked-learning-repository';
export function createD1LinkedLearningRepository(database:D1Database):LinkedLearningRepository {
 return {async findCourse(installationId,contextId){
  const {results:rows}=await database.prepare(`SELECT c.id AS "courseId", c.user_id AS "ownerUserId", t.teacher_subject AS "teacherSubject",
        t.resource_link_id AS "resourceLinkId", c.name AS "courseTitle", v.id AS "videoId", v.title AS "videoTitle"
      FROM teaching_connections t
      JOIN video_courses c ON c.id=t.course_id AND c.user_id=t.owner_user_id AND c.native_access_disabled=0
      JOIN users u ON u.id=c.user_id AND u.is_active=1 AND u.deactivated_at IS NULL
        AND (u.banned IS NOT TRUE OR julianday(u.ban_expires)<=julianday('now'))
      LEFT JOIN video_course_members m ON m.course_id=c.id
      LEFT JOIN videos v ON v.id=m.video_id AND v.user_id=c.user_id AND v.status='completed'
      WHERE t.provider='moodle' AND t.installation_id=? AND t.context_id=? AND t.active=1
      ORDER BY m."order",m.id`).bind(installationId,contextId).all<{
   courseId:number;ownerUserId:string;teacherSubject:string;resourceLinkId:string|null;courseTitle:string;videoId:number|null;videoTitle:string|null;
  }>();
  const row=rows[0];if(!row)return null;
  return {courseId:row.courseId,ownerUserId:row.ownerUserId,teacherSubject:row.teacherSubject,resourceLinkId:row.resourceLinkId,courseTitle:row.courseTitle,
   videos:rows.flatMap(item=>item.videoId===null?[]:[{videoId:item.videoId,lesson:String(item.videoId),title:item.videoTitle||row.courseTitle}])};
 }};
}
