import { isSafeMediaPath } from "../../shared/media-path";
import type { MediaRepository } from "../contracts/media-repository";

// LMS-controlled material never becomes public through a native course link.
const EXTERNAL_ACCESS = `course.managed_by_lms=0 AND course.native_access_disabled=0 AND NOT EXISTS (
  SELECT 1 FROM video_course_members protected_member JOIN videos protected_video ON protected_video.id=protected_member.video_id
  WHERE protected_member.course_id=course.id AND protected_video.managed_by_lms=1)`;

export function createD1MediaRepository(database: D1Database): MediaRepository {
  return {
    async getPathAccess(path, options) {
      const safePath = isSafeMediaPath(path);
      if (options.shareSlug != null) {
        const row = await database.prepare(`SELECT ?=1 AND EXISTS (
          SELECT 1 FROM videos media_video JOIN video_course_members member ON member.video_id=media_video.id
          WHERE media_video.file=? AND member.course_id=course.id) AS allowed
          FROM video_courses course WHERE course.share_slug=? AND ${EXTERNAL_ACCESS} LIMIT 1`)
          .bind(safePath ? 1 : 0, path, options.shareSlug).first<{ allowed: number }>();
        return row ? Boolean(row.allowed) : null;
      }
      if (!safePath || options.userId == null) return false;
      const row = await database.prepare(`SELECT 1 AS allowed FROM videos WHERE file=? AND (user_id=? OR EXISTS (
        SELECT 1 FROM video_course_members member JOIN video_course_memberships membership ON membership.course_id=member.course_id
          JOIN video_courses course ON course.id=member.course_id
        WHERE member.video_id=videos.id AND membership.user_id=? AND ${EXTERNAL_ACCESS})) LIMIT 1`)
        .bind(path, options.userId, options.userId).first();
      return Boolean(row);
    },
  };
}
