import {
  uniqueMembershipIds,
  planTagAttachment,
  membershipCourseAllowed,
  membershipVideoAllowed,
  matchesMembershipOrder,
} from "../../domain/learning/membership-policy";
import { membershipDrizzleLogic } from "../membership-policy-sql";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { withDb, type Db } from "../../db/pool";
import { sqlNumberArray } from "../../db/sql-array";
import {
  tags,
  videos,
  videoCourses,
  videoCourseMembers,
  videoTags,
} from "../../db/schema";
import type { Bindings } from "../../types/bindings";

/**
 * video↔tag / course↔video の関連付け書き込み（トランザクション適用）。
 * video/course の user_id による所有権判定を各書き込み前に行う。
 */

// ---- 所有確認 ----
// =========================================================================
// video ↔ tag
// =========================================================================

async function lockOwnedVideo(
  db: Pick<Db, "select">,
  videoId: number,
  userId: string,
) {
  const rows = await db
    .select({ id: videos.id })
    .from(videos)
    .where(and(eq(videos.id, videoId), eq(videos.userId, userId)))
    .limit(1)
    .for("update");
  return rows.length > 0;
}

/** 所有確認と関連付けを同じtransactionで実行し、実際の追加件数を返す。 */
export async function attachTags(
  env: Bindings,
  videoId: number,
  userId: string,
  tagIds: number[],
): Promise<
  { notFound: "Video not found" | "Resource not found" } | { added: number }
> {
  return withDb(env, (db) =>
    db.transaction(async (tx) => {
      if (!(await lockOwnedVideo(tx, videoId, userId)))
        return { notFound: "Video not found" } as const;
      const uniqueIds = uniqueMembershipIds(tagIds);
      if (uniqueIds.length === 0) return { added: 0 };

      // Only requested tags are read. Share locks prevent deletion/ownership changes
      // while allowing other videos to use the same tags concurrently.
      const requested = await tx
        .select({ id: tags.id, userId: tags.userId, attachedId: videoTags.id })
        .from(tags)
        .leftJoin(
          videoTags,
          and(eq(videoTags.tagId, tags.id), eq(videoTags.videoId, videoId)),
        )
        .where(inArray(tags.id, uniqueIds))
        .orderBy(asc(tags.id))
        .for("share", { of: tags });
      const plan = planTagAttachment(
        uniqueIds,
        requested.map((tag) => ({
          id: tag.id,
          ownerUserId: tag.userId,
          alreadyLinked: tag.attachedId !== null,
        })),
        userId,
      );
      if (plan.kind === "missing")
        return { notFound: "Resource not found" } as const;
      const idsToAdd = plan.ids;
      if (idsToAdd.length === 0) return { added: 0 };
      const inserted = await tx
        .insert(videoTags)
        .values(
          idsToAdd.map((tagId) => ({
            videoId,
            tagId,
            addedAt: sql`CURRENT_TIMESTAMP`,
          })),
        )
        .onConflictDoNothing({ target: [videoTags.tagId, videoTags.videoId] })
        .returning({ id: videoTags.id });
      return { added: inserted.length };
    }),
  );
}

/** 所有確認から削除まで動画・タグのロックを保持する。 */
export async function detachTag(
  env: Bindings,
  videoId: number,
  tagId: number,
  userId: string,
): Promise<
  | { notFound: "Video not found" | "Tag not found" | "Resource not found" }
  | { ok: true }
> {
  return withDb(env, (db) =>
    db.transaction(async (tx) => {
      if (!(await lockOwnedVideo(tx, videoId, userId)))
        return { notFound: "Video not found" } as const;
      const tag = await tx
        .select({ id: tags.id })
        .from(tags)
        .where(and(eq(tags.id, tagId), eq(tags.userId, userId)))
        .limit(1)
        .for("share");
      if (tag.length === 0) return { notFound: "Tag not found" } as const;
      const deleted = await tx
        .delete(videoTags)
        .where(and(eq(videoTags.videoId, videoId), eq(videoTags.tagId, tagId)))
        .returning({ id: videoTags.id });
      return deleted.length > 0
        ? ({ ok: true } as const)
        : ({ notFound: "Resource not found" } as const);
    }),
  );
}

// =========================================================================
// course ↔ video（単体）
// =========================================================================

async function lockOwnedCourse(
  db: Pick<Db, "select">,
  courseId: number,
  userId: string,
) {
  const rows = await db
    .select({ id: videoCourses.id })
    .from(videoCourses)
    .where(
      and(
        eq(videoCourses.id, courseId),
        membershipCourseAllowed(
          {
            owned: eq(videoCourses.userId, userId),
            native: eq(videoCourses.managedByLms, false),
          },
          membershipDrizzleLogic,
        ),
      ),
    )
    .limit(1)
    .for("update");
  return rows.length > 0;
}

async function lockOwnedCourseVideos(
  db: Pick<Db, "select">,
  videoIds: number[],
  userId: string,
  operation: "add" | "remove" = "add",
) {
  const rows = await db
    .select({ id: videos.id })
    .from(videos)
    .where(
      and(
        inArray(videos.id, videoIds),
        membershipVideoAllowed(
          operation,
          {
            owned: eq(videos.userId, userId),
            native: eq(videos.managedByLms, false),
          },
          membershipDrizzleLogic,
        ),
      ),
    )
    .orderBy(asc(videos.id))
    .for("share");
  return rows.length === videoIds.length;
}

type CourseVideoNotFound = { notFound: "Course not found" | "Video not found" };

/** 所有する講座・動画をロックしてから、既存の関連付けを再利用または末尾に追加する。 */
export async function addVideoToCourse(
  env: Bindings,
  courseId: number,
  videoId: number,
  userId: string,
): Promise<
  CourseVideoNotFound | { alreadyIn: true; id: number } | { id: number }
> {
  return withDb(env, (db) =>
    db.transaction(async (tx) => {
      if (!(await lockOwnedCourse(tx, courseId, userId)))
        return { notFound: "Course not found" } as const;
      if (!(await lockOwnedCourseVideos(tx, [videoId], userId)))
        return { notFound: "Video not found" } as const;
      const [existing] = await tx
        .select({ id: videoCourseMembers.id })
        .from(videoCourseMembers)
        .where(
          and(
            eq(videoCourseMembers.courseId, courseId),
            eq(videoCourseMembers.videoId, videoId),
          ),
        )
        .limit(1);
      if (existing)
        return { alreadyIn: true, id: Number(existing.id) } as const;
      const [inserted] = await tx
        .insert(videoCourseMembers)
        .values({
          courseId,
          videoId,
          order: sql`(${tx
            .select({
              value: sql`COALESCE(MAX(${videoCourseMembers.order}),-1)+1`,
            })
            .from(videoCourseMembers)
            .where(eq(videoCourseMembers.courseId, courseId))})`,
          addedAt: sql`CURRENT_TIMESTAMP`,
        })
        .returning({ id: videoCourseMembers.id });
      return { id: Number(inserted.id) };
    }),
  );
}

/** 所有確認から関連付けの削除まで講座・動画のロックを保持する。 */
export async function removeVideoFromCourse(
  env: Bindings,
  courseId: number,
  videoId: number,
  userId: string,
): Promise<CourseVideoNotFound | { notMember: true } | { ok: true }> {
  return withDb(env, (db) =>
    db.transaction(async (tx) => {
      if (!(await lockOwnedCourse(tx, courseId, userId)))
        return { notFound: "Course not found" } as const;
      if (!(await lockOwnedCourseVideos(tx, [videoId], userId, "remove")))
        return { notFound: "Video not found" } as const;
      const rows = await tx
        .delete(videoCourseMembers)
        .where(
          and(
            eq(videoCourseMembers.courseId, courseId),
            eq(videoCourseMembers.videoId, videoId),
          ),
        )
        .returning({ id: videoCourseMembers.id });
      return rows.length > 0
        ? ({ ok: true } as const)
        : ({ notMember: true } as const);
    }),
  );
}

/** 所有確認・重複除去と一括追加を同じtransactionで行い、入力順に末尾へ追加する。 */
export async function addVideosBulk(
  env: Bindings,
  courseId: number,
  videoIds: number[],
  userId: string,
): Promise<
  { notFound: "Course not found" | "Some videos not found" } | { added: number }
> {
  return withDb(env, (db) =>
    db.transaction(async (tx) => {
      if (!(await lockOwnedCourse(tx, courseId, userId)))
        return { notFound: "Course not found" } as const;
      const uniqueIds = uniqueMembershipIds(videoIds);
      if (uniqueIds.length === 0) return { added: 0 };
      if (!(await lockOwnedCourseVideos(tx, uniqueIds, userId)))
        return { notFound: "Some videos not found" } as const;

      const existing = await tx
        .select({ id: videoCourseMembers.videoId })
        .from(videoCourseMembers)
        .where(
          and(
            eq(videoCourseMembers.courseId, courseId),
            inArray(videoCourseMembers.videoId, uniqueIds),
          ),
        );
      const present = new Set(existing.map((row) => row.id));
      const candidates = uniqueIds.filter((id) => !present.has(id));
      if (!candidates.length) return { added: 0 };
      const [last] = await tx
        .select({
          slot: sql<number>`coalesce(max(${videoCourseMembers.order}),-1)`,
        })
        .from(videoCourseMembers)
        .where(eq(videoCourseMembers.courseId, courseId));
      // The course row is locked for this whole transaction, so filtering and
      // assigning order in TS cannot interleave with another membership writer.
      const inserted = await tx
        .insert(videoCourseMembers)
        .values(
          candidates.map((videoId, index) => ({
            courseId,
            videoId,
            order: last.slot + index + 1,
            addedAt: sql`CURRENT_TIMESTAMP`,
          })),
        )
        .returning({ id: videoCourseMembers.id });
      return { added: inserted.length };
    }),
  );
}

export async function reorderVideos(
  env: Bindings,
  courseId: number,
  userId: string,
  videoIds: number[],
): Promise<{ notFound: true } | { mismatch: true } | { ok: true }> {
  return withDb(env, async (db) => {
    return db.transaction(async (tx) => {
      const owner = await tx
        .select({ id: videoCourses.id })
        .from(videoCourses)
        .where(
          and(
            eq(videoCourses.id, courseId),
            membershipCourseAllowed(
              {
                owned: eq(videoCourses.userId, userId),
                native: eq(videoCourses.managedByLms, false),
              },
              membershipDrizzleLogic,
            ),
          ),
        )
        .for("update");
      if (owner.length === 0) return { notFound: true } as const;

      const members = await tx
        .select({ videoId: videoCourseMembers.videoId })
        .from(videoCourseMembers)
        .where(eq(videoCourseMembers.courseId, courseId))
        .orderBy(asc(videoCourseMembers.videoId))
        .for("update");
      if (
        !matchesMembershipOrder(
          videoIds,
          members.map((member) => member.videoId),
        )
      )
        return { mismatch: true } as const;

      if (videoIds.length > 0) {
        await tx
          .update(videoCourseMembers)
          .set({ order: sql`requested.ord-1` })
          .from(
            sql`unnest(${sqlNumberArray(videoIds)}) WITH ORDINALITY AS requested(video_id,ord)`,
          )
          .where(
            and(
              eq(videoCourseMembers.courseId, courseId),
              sql`${videoCourseMembers.videoId}=requested.video_id`,
              sql`${videoCourseMembers.order} IS DISTINCT FROM requested.ord-1`,
            ),
          );
      }
      return { ok: true } as const;
    });
  });
}
