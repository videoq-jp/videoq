import { and, eq, exists, sql } from "drizzle-orm";
import {
  mediaAccessMode,
  mediaSharedPathValue,
  mediaAuthenticatedPermission,
} from "../../application/media-access";
import { nativeCourseDrizzleLogic } from "../native-course-policy-sql";
import type { MediaRepository } from "../contracts/media-repository";
import { createD1Connection } from "../../db/d1/connection";
import {
  videos,
  videoCourses,
  videoCourseMembers,
  videoCourseMemberships,
} from "../../db/schema/sqlite";
import { nativeCourseExternalAccess } from "./course-access";
export function createD1MediaRepository(database: D1Database): MediaRepository {
  const db = createD1Connection(database);
  return {
    async getPathAccess(path, options) {
      const mode = mediaAccessMode(path, options);
      if (mode.kind === "denied") return false;
      if (mode.kind === "shared") {
        const permission = mediaSharedPathValue(
          mode.safePath,
          () =>
            exists(
              db
                .select({ id: videos.id })
                .from(videos)
                .innerJoin(
                  videoCourseMembers,
                  eq(videoCourseMembers.videoId, videos.id),
                )
                .where(
                  and(
                    eq(videos.file, path),
                    eq(videoCourseMembers.courseId, videoCourses.id),
                  ),
                ),
            ),
          sql<boolean>`false`,
        );
        const [row] = await db
          .select({ allowed: permission })
          .from(videoCourses)
          .where(
            and(
              eq(videoCourses.shareSlug, mode.shareSlug),
              nativeCourseExternalAccess(),
            ),
          )
          .limit(1);
        return row ? Boolean(row.allowed) : null;
      }
      const permission = mediaAuthenticatedPermission(
        eq(videos.userId, mode.userId),
        exists(
          db
            .select({ id: videoCourseMembers.id })
            .from(videoCourseMembers)
            .innerJoin(
              videoCourseMemberships,
              eq(videoCourseMemberships.courseId, videoCourseMembers.courseId),
            )
            .innerJoin(
              videoCourses,
              eq(videoCourses.id, videoCourseMembers.courseId),
            )
            .where(
              and(
                eq(videoCourseMembers.videoId, videos.id),
                eq(videoCourseMemberships.userId, mode.userId),
                nativeCourseExternalAccess(),
              ),
            ),
        ),
        nativeCourseDrizzleLogic,
      );
      const rows = await db
        .select({ id: videos.id })
        .from(videos)
        .where(and(eq(videos.file, path), permission))
        .limit(1);
      return rows.length > 0;
    },
  };
}
