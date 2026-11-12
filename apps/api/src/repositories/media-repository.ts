import { and, eq, or, sql } from "drizzle-orm";
import { withDb } from "../db/pool";
import {
  videos,
  videoCourses,
  videoCourseMembers,
  videoCourseMemberships,
} from "../db/schema";
import type { Bindings } from "../types/bindings";
import { nativeCourseExternalAccess } from './course-authority';

/** path traversal を拒否する。 */
export function isSafeMediaPath(path: string): boolean {
  if (!path || path.startsWith("/") || path.includes("\\") || path.includes("\0")) return false;
  const parts = path.split("/");
  return !parts.some((p) => p === ".." || p === "");
}

/** One authorization snapshot; null means the share slug itself is invalid. */
export async function getMediaPathAccess(
  env: Bindings,
  path: string,
  opts: { userId?: string; shareSlug?: string },
): Promise<boolean | null> {
  const safePath = isSafeMediaPath(path);
  const shareSlug = opts.shareSlug;
  if (shareSlug != null) {
    return withDb(env, async (db) => {
      const rows = await db
        .select({ allowed: safePath ? sql<boolean>`EXISTS (
          SELECT 1 FROM ${videos} AS media_video
          JOIN ${videoCourseMembers} AS member ON member.video_id = media_video.id
          WHERE media_video.file = ${path}
            AND member.course_id = video_courses.id
        )` : sql<boolean>`false` })
        .from(videoCourses)
        .where(and(eq(videoCourses.shareSlug, shareSlug), nativeCourseExternalAccess()))
        .limit(1);
      return rows[0]?.allowed ?? null;
    });
  }
  if (!safePath || opts.userId == null) return false;
  const permission = or(
    eq(videos.userId, opts.userId),
    sql`EXISTS (
      SELECT 1 FROM ${videoCourseMembers}
      JOIN ${videoCourseMemberships}
        ON ${videoCourseMemberships.courseId} = ${videoCourseMembers.courseId}
      JOIN ${videoCourses} ON ${videoCourses.id} = ${videoCourseMembers.courseId}
      WHERE ${videoCourseMembers.videoId} = ${videos.id}
        AND ${videoCourseMemberships.userId} = ${opts.userId}
        AND ${nativeCourseExternalAccess()}
    )`,
  );
  return withDb(env, async (db) => {
    const rows = await db
      .select({ id: videos.id })
      .from(videos)
      .where(and(eq(videos.file, path), permission))
      .limit(1);
    return rows.length > 0;
  });
}
