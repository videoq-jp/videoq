import { and, eq, or, sql, type SQL, type AnyColumn } from 'drizzle-orm';
import { videoCourses, videoCourseMemberships } from '../db/schema';

/** Native invitations and public links never substitute for Moodle access.
 * Old independent courses may already contain an LMS video: deny the whole
 * external course scope, including any saved model memory, in that case too.
 */
export function nativeCourseExternalAccess(
  courseId: AnyColumn | SQL = videoCourses.id,
  managedByLms: AnyColumn | SQL = videoCourses.managedByLms,
  nativeAccessDisabled: AnyColumn | SQL = videoCourses.nativeAccessDisabled,
) {
  return sql`${managedByLms} = false AND ${nativeAccessDisabled} = false AND NOT EXISTS (
    SELECT 1 FROM video_course_members protected_member
      JOIN videos protected_video ON protected_video.id = protected_member.video_id
     WHERE protected_member.course_id = ${courseId} AND protected_video.managed_by_lms = true
  )`;
}

/** Independently authenticated data owners retain operator access. */
export function nativeCourseReadableBy(userId: string) {
  return or(eq(videoCourses.userId, userId), and(nativeCourseExternalAccess(), sql`EXISTS (
    SELECT 1 FROM ${videoCourseMemberships}
     WHERE ${videoCourseMemberships.courseId} = ${videoCourses.id}
       AND ${videoCourseMemberships.userId} = ${userId}
  )`))!;
}
