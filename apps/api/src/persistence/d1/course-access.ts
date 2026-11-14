/** Alias must be `course`; native links never grant LMS-controlled material. */
export const NATIVE_COURSE_EXTERNAL=`course.managed_by_lms=0 AND course.native_access_disabled=0 AND NOT EXISTS(
  SELECT 1 FROM video_course_members protected_member JOIN videos protected_video ON protected_video.id=protected_member.video_id
  WHERE protected_member.course_id=course.id AND protected_video.managed_by_lms=1)`;
