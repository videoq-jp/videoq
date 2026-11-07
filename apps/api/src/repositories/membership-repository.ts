import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { withDb, type Db } from "../db/pool";
import { sqlNumberArray } from "../db/sql-array";
import {
  tags,
  videos,
  videoCourses,
  videoCourseMembers,
  videoTags,
} from "../db/schema";
import type { Bindings } from "../types/bindings";

/**
 * video↔tag / course↔video の関連付け書き込み（トランザクション適用）。
 * video/course の user_id による所有権判定を各書き込み前に行う。
 */

// ---- 所有確認 ----
export async function videoOwnedBy(
  env: Bindings,
  videoId: number,
  userId: string,
): Promise<boolean> {
  return withDb(env, async (db) => {
    const rows = await db
      .select({ id: videos.id })
      .from(videos)
      .where(and(eq(videos.id, videoId), eq(videos.userId, userId)))
      .limit(1);
    return rows.length > 0;
  });
}

// =========================================================================
// video ↔ tag
// =========================================================================

async function lockOwnedVideo(db: Pick<Db, "select">, videoId: number, userId: string) {
  const rows = await db.select({ id: videos.id }).from(videos)
    .where(and(eq(videos.id, videoId), eq(videos.userId, userId)))
    .limit(1).for("update");
  return rows.length > 0;
}

/** 所有確認と関連付けを同じtransactionで実行し、実際の追加件数を返す。 */
export async function attachTags(
  env: Bindings,
  videoId: number,
  userId: string,
  tagIds: number[],
): Promise<{ notFound: "Video not found" | "Resource not found" } | { added: number }> {
  return withDb(env, (db) => db.transaction(async (tx) => {
    if (!await lockOwnedVideo(tx, videoId, userId)) return { notFound: "Video not found" } as const;
    const uniqueIds = [...new Set(tagIds)];
    if (uniqueIds.length === 0) return { added: 0 };

    // Only requested tags are read. Share locks prevent deletion/ownership changes
    // while allowing other videos to use the same tags concurrently.
    const requested = await tx.select({ id: tags.id, userId: tags.userId, attachedId: videoTags.id })
      .from(tags)
      .leftJoin(videoTags, and(eq(videoTags.tagId, tags.id), eq(videoTags.videoId, videoId)))
      .where(inArray(tags.id, uniqueIds))
      .orderBy(asc(tags.id))
      .for("share", { of: tags });
    if (requested.length !== uniqueIds.length || requested.some(tag => tag.attachedId === null && tag.userId !== userId)) {
      return { notFound: "Resource not found" } as const;
    }
    const idsToAdd = requested.filter(tag => tag.attachedId === null).map(tag => tag.id);
    if (idsToAdd.length === 0) return { added: 0 };
    const inserted = await tx.insert(videoTags)
      .values(idsToAdd.map(tagId => ({ videoId, tagId, addedAt: sql`CURRENT_TIMESTAMP` })))
      .onConflictDoNothing({ target: [videoTags.tagId, videoTags.videoId] })
      .returning({ id: videoTags.id });
    return { added: inserted.length };
  }));
}

/** 所有確認から削除まで動画・タグのロックを保持する。 */
export async function detachTag(
  env: Bindings,
  videoId: number,
  tagId: number,
  userId: string,
): Promise<{ notFound: "Video not found" | "Tag not found" | "Resource not found" } | { ok: true }> {
  return withDb(env, (db) => db.transaction(async (tx) => {
    if (!await lockOwnedVideo(tx, videoId, userId)) return { notFound: "Video not found" } as const;
    const tag = await tx.select({ id: tags.id }).from(tags)
      .where(and(eq(tags.id, tagId), eq(tags.userId, userId))).limit(1).for("share");
    if (tag.length === 0) return { notFound: "Tag not found" } as const;
    const deleted = await tx.delete(videoTags)
      .where(and(eq(videoTags.videoId, videoId), eq(videoTags.tagId, tagId)))
      .returning({ id: videoTags.id });
    return deleted.length > 0 ? { ok: true } as const : { notFound: "Resource not found" } as const;
  }));
}

// =========================================================================
// course ↔ video（単体）
// =========================================================================

async function lockOwnedCourse(db: Pick<Db, "select">, courseId: number, userId: string) {
  const rows = await db.select({ id: videoCourses.id }).from(videoCourses)
    .where(and(eq(videoCourses.id, courseId), eq(videoCourses.userId, userId), eq(videoCourses.managedByLms, false)))
    .limit(1).for("update");
  return rows.length > 0;
}

async function lockOwnedCourseVideos(db: Pick<Db, "select">, videoIds: number[], userId: string, allowLmsCleanup = false) {
  const rows = await db.select({ id: videos.id }).from(videos)
    .where(and(inArray(videos.id, videoIds), eq(videos.userId, userId), allowLmsCleanup ? undefined : eq(videos.managedByLms, false)))
    .orderBy(asc(videos.id)).for("share");
  return rows.length === videoIds.length;
}

type CourseVideoNotFound = { notFound: "Course not found" | "Video not found" };

/** 所有する講座・動画をロックしてから、既存の関連付けを再利用または末尾に追加する。 */
export async function addVideoToCourse(
  env: Bindings,
  courseId: number,
  videoId: number,
  userId: string,
): Promise<CourseVideoNotFound | { alreadyIn: true; id: number } | { id: number }> {
  return withDb(env, (db) => db.transaction(async (tx) => {
    if (!await lockOwnedCourse(tx, courseId, userId)) return { notFound: "Course not found" } as const;
    if (!await lockOwnedCourseVideos(tx, [videoId], userId)) return { notFound: "Video not found" } as const;
    const [existing] = await tx.select({ id: videoCourseMembers.id }).from(videoCourseMembers)
      .where(and(eq(videoCourseMembers.courseId, courseId), eq(videoCourseMembers.videoId, videoId)))
      .limit(1);
    if (existing) return { alreadyIn: true, id: Number(existing.id) } as const;
    const [inserted] = await tx.insert(videoCourseMembers)
      .values({
        courseId,
        videoId,
        order: sql`(SELECT COALESCE(MAX("order"), -1) + 1 FROM video_course_members WHERE course_id = ${courseId})`,
        addedAt: sql`CURRENT_TIMESTAMP`,
      })
      .returning({ id: videoCourseMembers.id });
    return { id: Number(inserted.id) };
  }));
}

/** 所有確認から関連付けの削除まで講座・動画のロックを保持する。 */
export async function removeVideoFromCourse(
  env: Bindings,
  courseId: number,
  videoId: number,
  userId: string,
): Promise<CourseVideoNotFound | { notMember: true } | { ok: true }> {
  return withDb(env, (db) => db.transaction(async (tx) => {
    if (!await lockOwnedCourse(tx, courseId, userId)) return { notFound: "Course not found" } as const;
    if (!await lockOwnedCourseVideos(tx, [videoId], userId, true)) return { notFound: "Video not found" } as const;
    const rows = await tx.delete(videoCourseMembers)
      .where(and(eq(videoCourseMembers.courseId, courseId), eq(videoCourseMembers.videoId, videoId)))
      .returning({ id: videoCourseMembers.id });
    return rows.length > 0 ? { ok: true } as const : { notMember: true } as const;
  }));
}

/** 所有確認・重複除去と一括追加を同じtransactionで行い、入力順に末尾へ追加する。 */
export async function addVideosBulk(
  env: Bindings,
  courseId: number,
  videoIds: number[],
  userId: string,
): Promise<{ notFound: "Course not found" | "Some videos not found" } | { added: number }> {
  return withDb(env, (db) => db.transaction(async (tx) => {
    if (!await lockOwnedCourse(tx, courseId, userId)) return { notFound: "Course not found" } as const;
    const uniqueIds = [...new Set(videoIds)];
    if (uniqueIds.length === 0) return { added: 0 };
    if (!await lockOwnedCourseVideos(tx, uniqueIds, userId)) return { notFound: "Some videos not found" } as const;

    const inserted = await tx.execute(sql`
      INSERT INTO video_course_members (course_id, video_id, "order", added_at)
      SELECT ${courseId}, v.video_id,
             (SELECT COALESCE(MAX("order"), -1) FROM video_course_members WHERE course_id = ${courseId})
               + ROW_NUMBER() OVER (ORDER BY v.ord),
             CURRENT_TIMESTAMP
        FROM unnest(${sqlNumberArray(uniqueIds)}) WITH ORDINALITY AS v(video_id, ord)
       WHERE NOT EXISTS (
         SELECT 1 FROM video_course_members
          WHERE course_id = ${courseId} AND video_id = v.video_id
       )
      RETURNING id
    `);
    return { added: inserted.rows.length };
  }));
}
