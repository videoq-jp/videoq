import { NATIVE_COURSE_EXTERNAL } from './course-access';
import { mediaAccessMode, mediaSharedPermission, mediaAuthenticatedPermission } from '../../application/media-access';
import { nativeCourseStringLogic } from '../native-course-policy-sql';
import type { MediaRepository } from "../contracts/media-repository";

// LMS-controlled material never becomes public through a native course link.
const EXTERNAL_ACCESS = NATIVE_COURSE_EXTERNAL;

export function createD1MediaRepository(database: D1Database): MediaRepository {
  return {
    async getPathAccess(path, options) {
      const mode=mediaAccessMode(path,options);
      if(mode.kind==='denied')return false;
      if (mode.kind==='shared') {
        const permission=mediaSharedPermission('?=1',`EXISTS (
          SELECT 1 FROM videos media_video JOIN video_course_members member ON member.video_id=media_video.id
          WHERE media_video.file=? AND member.course_id=course.id)`,nativeCourseStringLogic);
        const row = await database.prepare(`SELECT ${permission} AS allowed
          FROM video_courses course WHERE course.share_slug=? AND ${EXTERNAL_ACCESS} LIMIT 1`)
          .bind(mode.safePath ? 1 : 0, path, mode.shareSlug).first<{ allowed: number }>();
        return row ? Boolean(row.allowed) : null;
      }
      const permission=mediaAuthenticatedPermission('user_id=?',`EXISTS (
        SELECT 1 FROM video_course_members member JOIN video_course_memberships membership ON membership.course_id=member.course_id
          JOIN video_courses course ON course.id=member.course_id
        WHERE member.video_id=videos.id AND membership.user_id=? AND ${EXTERNAL_ACCESS})`,nativeCourseStringLogic);
      const row = await database.prepare(`SELECT 1 AS allowed FROM videos WHERE file=? AND ${permission} LIMIT 1`)
        .bind(path, mode.userId, mode.userId).first();
      return Boolean(row);
    },
  };
}
