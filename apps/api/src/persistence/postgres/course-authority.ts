import { QueryBuilder, alias } from "drizzle-orm/pg-core";
import {
  nativeCourseExternalAllowed,
  nativeCourseAccessAllowed,
} from "../../application/native-course-access";
import { nativeCourseDrizzleLogic } from "../native-course-policy-sql";
import {
  sql,
  and,
  eq,
  exists,
  notExists,
  type SQL,
  type AnyColumn,
} from "drizzle-orm";
import {
  videoCourses,
  videoCourseMemberships,
  videoCourseMembers,
  videos,
} from "../../db/schema";

/** Native invitations and public links never substitute for Moodle access.
 * Old independent courses may already contain an LMS video: deny the whole
 * external course scope, including any saved model memory, in that case too.
 */
export function nativeCourseExternalAccess(
  courseId: AnyColumn | SQL = videoCourses.id,
  managedByLms: AnyColumn | SQL = videoCourses.managedByLms,
  nativeAccessDisabled: AnyColumn | SQL = videoCourses.nativeAccessDisabled,
) {
  const member = alias(videoCourseMembers, "protected_member"),
    video = alias(videos, "protected_video");
  return nativeCourseExternalAllowed(
    {
      independentlyManaged: sql`${managedByLms}=false`,
      nativeAccessEnabled: sql`${nativeAccessDisabled}=false`,
      noLmsVideo: notExists(
        new QueryBuilder()
          .select({ courseId: member.courseId })
          .from(member)
          .innerJoin(video, eq(video.id, member.videoId))
          .where(
            and(
              sql`${member.courseId}=${courseId}`,
              eq(video.managedByLms, true),
            ),
          ),
      ),
    },
    nativeCourseDrizzleLogic,
  );
}

/** Independently authenticated data owners retain operator access. */
export function nativeCourseReadableBy(userId: string) {
  return nativeCourseAccessAllowed(
    false,
    {
      owner: sql`${videoCourses.userId} = ${userId}`,
      nativeEnabled: nativeCourseExternalAccess(),
      participant: exists(
        new QueryBuilder()
          .select({ courseId: videoCourseMemberships.courseId })
          .from(videoCourseMemberships)
          .where(
            and(
              eq(videoCourseMemberships.courseId, videoCourses.id),
              eq(videoCourseMemberships.userId, userId),
            ),
          ),
      ),
      shareMatches: sql`false`,
    },
    nativeCourseDrizzleLogic,
  );
}
