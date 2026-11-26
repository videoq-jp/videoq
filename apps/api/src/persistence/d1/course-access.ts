import { and, eq, notExists } from "drizzle-orm";
import {
  videoCourses,
  videoCourseMembers,
  videos,
} from "../../db/schema/sqlite";
import { QueryBuilder } from "drizzle-orm/sqlite-core";
import { nativeCourseDrizzleLogic } from "../native-course-policy-sql";
import { nativeCourseExternalAllowed } from "../../domain/learning/native-course-access";
/** Shared native access predicate for typed query builders. */
export function nativeCourseExternalAccess() {
  const db = new QueryBuilder();
  return nativeCourseExternalAllowed(
    {
      independentlyManaged: eq(videoCourses.managedByLms, false),
      nativeAccessEnabled: eq(videoCourses.nativeAccessDisabled, false),
      noLmsVideo: notExists(
        db
          .select({ id: videoCourseMembers.videoId })
          .from(videoCourseMembers)
          .innerJoin(videos, eq(videos.id, videoCourseMembers.videoId))
          .where(
            and(
              eq(videoCourseMembers.courseId, videoCourses.id),
              eq(videos.managedByLms, true),
            ),
          ),
      ),
    },
    nativeCourseDrizzleLogic,
  );
}
