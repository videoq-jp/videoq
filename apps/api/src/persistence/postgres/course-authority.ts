import { nativeCourseExternalAllowed, nativeCourseAccessAllowed } from '../../application/native-course-access';
import { nativeCourseDrizzleLogic } from '../native-course-policy-sql';
import { sql, type SQL, type AnyColumn } from 'drizzle-orm';
import { videoCourses, videoCourseMemberships } from '../../db/schema';

/** Native invitations and public links never substitute for Moodle access.
 * Old independent courses may already contain an LMS video: deny the whole
 * external course scope, including any saved model memory, in that case too.
 */
export function nativeCourseExternalAccess(
  courseId: AnyColumn | SQL = videoCourses.id,
  managedByLms: AnyColumn | SQL = videoCourses.managedByLms,
  nativeAccessDisabled: AnyColumn | SQL = videoCourses.nativeAccessDisabled,
) {
  return nativeCourseExternalAllowed({ independentlyManaged: sql`${managedByLms} = false`,
    nativeAccessEnabled: sql`${nativeAccessDisabled} = false`, noLmsVideo: sql`NOT EXISTS (
    SELECT 1 FROM video_course_members protected_member
      JOIN videos protected_video ON protected_video.id = protected_member.video_id
     WHERE protected_member.course_id = ${courseId} AND protected_video.managed_by_lms = true
  )` }, nativeCourseDrizzleLogic);
}

/** Independently authenticated data owners retain operator access. */
export function nativeCourseReadableBy(userId: string) {
  return nativeCourseAccessAllowed(false, { owner: sql`${videoCourses.userId} = ${userId}`,
    nativeEnabled: nativeCourseExternalAccess(), participant: sql`EXISTS (
    SELECT 1 FROM ${videoCourseMemberships}
     WHERE ${videoCourseMemberships.courseId} = ${videoCourses.id}
       AND ${videoCourseMemberships.userId} = ${userId}
  )`, shareMatches: sql`false` }, nativeCourseDrizzleLogic);
}
