import { mediaAccessMode, mediaSharedPathValue, mediaAuthenticatedPermission } from '../../application/media-access';
import { nativeCourseDrizzleLogic } from '../native-course-policy-sql';
import type { MediaRepository } from "../contracts/media-repository";
import { and, eq, sql } from "drizzle-orm";
import { withDb } from "../../db/pool";
import {
  videos,
  videoCourses,
  videoCourseMembers,
  videoCourseMemberships,
} from "../../db/schema";
import type { Bindings } from "../../types/bindings";
import { nativeCourseExternalAccess } from './course-authority';

/** One authorization snapshot; null means the share slug itself is invalid. */
export async function getMediaPathAccess(
  env: Bindings,
  path: string,
  opts: { userId?: string; shareSlug?: string },
): Promise<boolean | null> {
  const mode = mediaAccessMode(path, opts);
  if (mode.kind === 'denied') return false;
  if (mode.kind === 'shared') {
    return withDb(env, async (db) => {
      const rows = await db
        .select({ allowed: mediaSharedPathValue(mode.safePath, () => sql<boolean>`EXISTS (
          SELECT 1 FROM ${videos} AS media_video
          JOIN ${videoCourseMembers} AS member ON member.video_id = media_video.id
          WHERE media_video.file = ${path}
            AND member.course_id = video_courses.id
        )`, sql<boolean>`false`) })
        .from(videoCourses)
        .where(and(eq(videoCourses.shareSlug, mode.shareSlug), nativeCourseExternalAccess()))
        .limit(1);
      return rows[0]?.allowed ?? null;
    });
  }
  const permission = mediaAuthenticatedPermission(
    eq(videos.userId, mode.userId),
    sql`EXISTS (
      SELECT 1 FROM ${videoCourseMembers}
      JOIN ${videoCourseMemberships}
        ON ${videoCourseMemberships.courseId} = ${videoCourseMembers.courseId}
      JOIN ${videoCourses} ON ${videoCourses.id} = ${videoCourseMembers.courseId}
      WHERE ${videoCourseMembers.videoId} = ${videos.id}
        AND ${videoCourseMemberships.userId} = ${mode.userId}
        AND ${nativeCourseExternalAccess()}
    )`, nativeCourseDrizzleLogic,
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

export function createPostgresMediaRepository(env: Bindings): MediaRepository {
 return { getPathAccess: (path,options)=>getMediaPathAccess(env,path,options) };
}
