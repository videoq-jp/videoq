import { nativeCourseExternalAllowed } from '../../application/native-course-access';
import { nativeCourseStringLogic } from '../native-course-policy-sql';

/** Closed aliases belong to adapters; no caller-provided SQL identifiers. */
export function nativeCourseExternalSql(alias: 'course' | 'c' | '"video_courses"'): string {
  return nativeCourseExternalAllowed({
    independentlyManaged: `${alias}.managed_by_lms=0`,
    nativeAccessEnabled: `${alias}.native_access_disabled=0`,
    noLmsVideo: `NOT EXISTS(SELECT 1 FROM video_course_members protected_member
      JOIN videos protected_video ON protected_video.id=protected_member.video_id
      WHERE protected_member.course_id=${alias}.id AND protected_video.managed_by_lms=1)`,
  }, nativeCourseStringLogic);
}
export const NATIVE_COURSE_EXTERNAL = nativeCourseExternalSql('course');
