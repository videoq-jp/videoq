import { QueryBuilder } from "drizzle-orm/pg-core";
import {
  courseEditable,
  validCourseOrderInput,
  courseOrderAllowed,
  planSelectedCourseOrder,
  courseArrayOrderPlanning,
  courseAccessRole,
  courseAuthenticatedRole,
  courseOwnerPriority,
} from "../../application/course-management";
import {
  courseManagementDrizzleLogic,
  courseDrizzleRoleChoice,
  courseDrizzlePriorityChoice,
} from "../course-management-policy-sql";
import type {
  CourseRepository,
  CourseInfo,
  CourseDetail,
  CourseListItem,
  CourseReadOptions,
} from "../contracts/course-repository";
import { and, asc, desc, eq, exists, type SQL, sql } from "drizzle-orm";
import { videoStatusSchema } from "@videoq/trpc";
import { type Db, withDb } from "../../db/pool";
import { isUniqueViolation } from "../../db/errors";
import { sqlNumberArray } from "../../db/sql-array";
import {
  users,
  mcpIdempotencyRecords,
  videos,
  videoCourses,
  videoCourseMembers,
} from "../../db/schema";
import {
  nativeCourseExternalAccess,
  nativeCourseReadableBy,
} from "./course-authority";
import { toUtcIso } from "../../shared/datetime";
import { mapVideoListRow } from "../../repositories/video-mapping";
import { videoTagsJson, visualProcessing } from "./video-read-repository";
import type { Bindings } from "../../types/bindings";
import {
  findIdempotentResource,
  recordIdempotentResource,
  type CreationIdempotency,
} from "./creation-idempotency";

const courseVideoCount = sql<number>`(${new QueryBuilder()
  .select({ value: sql`count(*)::int` })
  .from(videoCourseMembers)
  .where(eq(videoCourseMembers.courseId, videoCourses.id))})`.as("video_count");

/** ReAct 用の講座情報。確認済みの所有者に限定し、タグ・ファイル情報は取得しない。 */
export function getCourseInfo(
  env: Bindings,
  courseId: number,
  ownerUserId: string,
  options: {
    videoLimit: number;
    videoOffset: number;
    courseDescriptionLimit: number;
    videoDescriptionLimit: number;
    videoIds?: readonly number[];
  },
): Promise<CourseInfo | null> {
  return withDb(env, async (db) => {
    // PostgreSQL counts code points; one extra preserves the caller's UTF-16
    // slice/length checks even when the description contains surrogate pairs.
    const [course] = await db
      .select({
        name: videoCourses.name,
        description:
          sql<string>`left(${videoCourses.description}, ${options.courseDescriptionLimit + 1})`.as(
            "description",
          ),
        video_count:
          options.videoIds === undefined
            ? courseVideoCount
            : sql<number>`(${db
                .select({ value: sql`count(*)::int` })
                .from(videoCourseMembers)
                .where(
                  and(
                    eq(videoCourseMembers.courseId, videoCourses.id),
                    sql`${videoCourseMembers.videoId}=ANY(${sqlNumberArray(options.videoIds)})`,
                  ),
                )})`.as("video_count"),
      })
      .from(videoCourses)
      .where(
        and(
          eq(videoCourses.id, courseId),
          eq(videoCourses.userId, ownerUserId),
        ),
      )
      .limit(1);
    if (!course) return null;
    if (options.videoOffset >= course.video_count)
      return { ...course, videos: [] };
    const members = await db
      .select({
        id: videos.id,
        title: videos.title,
        description:
          sql<string>`left(${videos.description}, ${options.videoDescriptionLimit + 1})`.as(
            "description",
          ),
        status: videos.status,
        member_order: videoCourseMembers.order,
      })
      .from(videoCourseMembers)
      .innerJoin(videos, eq(videos.id, videoCourseMembers.videoId))
      .where(
        and(
          eq(videoCourseMembers.courseId, courseId),
          options.videoIds === undefined
            ? undefined
            : sql`${videos.id}=ANY(${sqlNumberArray(options.videoIds)})`,
        ),
      )
      .orderBy(
        asc(videoCourseMembers.order),
        asc(videoCourseMembers.addedAt),
        asc(videoCourseMembers.id),
      )
      .limit(options.videoLimit)
      .offset(options.videoOffset);
    return {
      ...course,
      videos: members.map((row) => ({
        id: Number(row.id),
        title: row.title,
        description: row.description,
        status: videoStatusSchema.parse(row.status),
        order: row.member_order,
      })),
    };
  });
}

const courseDetailSelect = {
  id: videoCourses.id,
  name: videoCourses.name,
  description: videoCourses.description,
  display_order: videoCourses.displayOrder,
  created_at: videoCourses.createdAt,
  updated_at: videoCourses.updatedAt,
  share_slug: videoCourses.shareSlug,
  video_count: courseVideoCount,
  owner_user_id: videoCourses.userId,
};

type CourseMetadata = Omit<CourseDetail, "videos" | "access_role"> & {
  owner_user_id: string;
};

async function readCourseMembers(
  db: Db,
  course: CourseMetadata,
  options: CourseReadOptions,
) {
  if ((options.videoOffset ?? 0) >= course.video_count) return [];

  let memberQuery = db
    .select({
      member_order: videoCourseMembers.order,
      id: videos.id,
      file: videos.file,
      title: videos.title,
      description: videos.description,
      uploaded_at: videos.uploadedAt,
      status: videos.status,
      source_type: videos.sourceType,
      source_url: videos.sourceUrl,
      youtube_video_id: videos.youtubeVideoId,
      tags:
        options.includeTags === false
          ? sql<string>`'[]'`.as("tags")
          : videoTagsJson,
      visual_processing: visualProcessing,
    })
    .from(videoCourseMembers)
    .innerJoin(videos, eq(videos.id, videoCourseMembers.videoId))
    .where(eq(videoCourseMembers.courseId, course.id))
    .orderBy(
      asc(videoCourseMembers.order),
      asc(videoCourseMembers.addedAt),
      asc(videoCourseMembers.id),
    )
    .$dynamic();
  if (options.videoLimit !== undefined) {
    memberQuery = memberQuery.limit(options.videoLimit);
  }
  if (options.videoOffset !== undefined) {
    memberQuery = memberQuery.offset(options.videoOffset);
  }
  return memberQuery;
}

async function mapCourseDetail(
  env: Bindings,
  data: {
    course: CourseMetadata;
    members: Awaited<ReturnType<typeof readCourseMembers>>;
  },
  accessRole: "public" | { viewerUserId: string },
  options: CourseReadOptions,
): Promise<CourseDetail> {
  const nestedVideos = await Promise.all(
    data.members.map(async (r) => ({
      ...(await mapVideoListRow(env, r, {
        includeFileUrl: options.includeFileUrls !== false,
      })),
      order: r.member_order,
    })),
  );

  const g = data.course;
  return {
    id: Number(g.id),
    name: g.name,
    description: g.description,
    display_order: g.display_order,
    created_at: toUtcIso(g.created_at),
    updated_at: toUtcIso(g.updated_at),
    video_count: g.video_count,
    share_slug: g.share_slug ?? null,
    videos: nestedVideos,
    access_role: courseAccessRole(accessRole, g.owner_user_id),
  };
}

/** 指定条件で講座詳細を取得し、DB接続を閉じてからメディアURLを生成する。 */
async function fetchCourseDetail(
  env: Bindings,
  where: SQL,
  accessRole: "public" | { viewerUserId: string },
  options: CourseReadOptions = {},
): Promise<CourseDetail | null> {
  const data = await withDb(env, async (db) => {
    const [course] = await db
      .select(courseDetailSelect)
      .from(videoCourses)
      .where(where)
      .limit(1);
    if (!course) return null;
    return { course, members: await readCourseMembers(db, course, options) };
  });
  return data ? mapCourseDetail(env, data, accessRole, options) : null;
}

/**
 * VideoCourseDetailView: id + user_id で1件取得（未所有/不在は null）。
 * videos は各メンバーの VideoListSerializer 出力 + order（メンバー順 order, added_at）。
 */
export function getCourseDetail(
  env: Bindings,
  courseId: number,
  userId: string,
  options: CourseReadOptions = {},
): Promise<CourseDetail | null> {
  return fetchCourseDetail(
    env,
    and(eq(videoCourses.id, courseId), nativeCourseReadableBy(userId))!,
    { viewerUserId: userId },
    options,
  );
}

/**
 * share_slug で1件取得する（認証不要・完全一致）。未一致は null。
 * 出力は VideoCourseDetailSerializer（getCourseDetail と同形）。
 */
export function getCourseDetailByShareSlug(
  env: Bindings,
  shareSlug: string,
  options: CourseReadOptions = {},
): Promise<CourseDetail | null> {
  return fetchCourseDetail(
    env,
    and(eq(videoCourses.shareSlug, shareSlug), nativeCourseExternalAccess())!,
    "public",
    options,
  );
}

/** 講座作成（display_order = MAX+1 を単一 INSERT で原子採番）。作成した id を返す。 */
export async function createCourse(
  env: Bindings,
  userId: string,
  name: string,
  description: string,
  idempotency?: CreationIdempotency,
): Promise<
  | { ok: true; courseId: number; reused: boolean }
  | { idempotencyConflict: true }
> {
  return withDb(env, async (db) =>
    db.transaction(async (tx) => {
      await tx
        .select({ id: users.id })
        .from(users)
        .where(eq(users.id, userId))
        .for("update");
      const existing = await findIdempotentResource(tx, userId, idempotency);
      if (existing.found) {
        if (existing.conflict) return { idempotencyConflict: true } as const;
        return {
          ok: true as const,
          courseId: existing.resourceId,
          reused: true,
        };
      }
      const rows = await tx
        .insert(videoCourses)
        .values({
          userId,
          name,
          description,
          displayOrder: sql`(${tx
            .select({
              value: sql`COALESCE(MAX(${videoCourses.displayOrder}),-1)+1`,
            })
            .from(videoCourses)
            .where(eq(videoCourses.userId, userId))})`,
          createdAt: sql`CURRENT_TIMESTAMP`,
          updatedAt: sql`CURRENT_TIMESTAMP`,
          shareSlug: null,
        })
        .returning({ id: videoCourses.id });
      const courseId = Number(rows[0].id);
      await recordIdempotentResource(tx, userId, idempotency, courseId);
      return { ok: true as const, courseId, reused: false };
    }),
  );
}

/** 更新結果と所属動画を同じtransactionで取得する。updated_at は更新しない。 */
export async function updateCourse(
  env: Bindings,
  courseId: number,
  userId: string,
  fields: { name?: string; description?: string },
): Promise<{ notFound: true } | { course: CourseDetail }> {
  const options = { includeTags: false };
  const data = await withDb(env, (db) =>
    db.transaction(async (tx) => {
      const patch: { name?: string; description?: string } = {};
      if (fields.name !== undefined) patch.name = fields.name;
      if (fields.description !== undefined)
        patch.description = fields.description;
      const where = and(
        eq(videoCourses.id, courseId),
        courseEditable(
          sql`${videoCourses.userId} = ${userId}`,
          sql`${videoCourses.managedByLms} = false`,
          courseManagementDrizzleLogic,
        ),
      );
      const [course] =
        Object.keys(patch).length > 0
          ? await tx
              .update(videoCourses)
              .set(patch)
              .where(where)
              .returning(courseDetailSelect)
          : await tx
              .select(courseDetailSelect)
              .from(videoCourses)
              .where(where)
              .for("update")
              .limit(1);
      if (!course) return null;
      return { course, members: await readCourseMembers(tx, course, options) };
    }),
  );
  if (!data) return { notFound: true };
  return {
    course: await mapCourseDetail(env, data, { viewerUserId: userId }, options),
  };
}

/** 講座削除（所有権を先に確認し、tx で cascade 削除）。 */
export async function deleteCourse(
  env: Bindings,
  courseId: number,
  userId: string,
): Promise<{ notFound: true } | { ok: true }> {
  return withDb(env, async (db) => {
    return db.transaction(async (tx) => {
      const owner = await tx
        .select({ id: videoCourses.id })
        .from(videoCourses)
        .where(
          and(
            eq(videoCourses.id, courseId),
            courseEditable(
              sql`${videoCourses.userId} = ${userId}`,
              sql`${videoCourses.managedByLms} = false`,
              courseManagementDrizzleLogic,
            ),
          ),
        )
        .for("update");
      if (owner.length === 0) return { notFound: true } as const;

      await tx
        .delete(mcpIdempotencyRecords)
        .where(
          and(
            eq(mcpIdempotencyRecords.userId, userId),
            eq(mcpIdempotencyRecords.action, "create_course"),
            eq(mcpIdempotencyRecords.resourceId, courseId),
          ),
        );
      // Course FKs cascade memberships, invitations, chat logs and their evaluations.
      await tx
        .delete(videoCourses)
        .where(
          and(eq(videoCourses.id, courseId), eq(videoCourses.userId, userId)),
        );
      return { ok: true } as const;
    });
  });
}

/**
 * 講座表示順を並び替える。
 * 空/重複 → mismatch。選択講座の既存 display_order 値集合を
 * ソート順のまま course_ids の並びへ再割り当て（値集合は保存）。
 */
export async function reorderCourses(
  env: Bindings,
  userId: string,
  courseIds: number[],
): Promise<{ mismatch: true } | { ok: true }> {
  if (!validCourseOrderInput(courseIds)) return { mismatch: true } as const;

  return withDb(env, async (db) => {
    return db.transaction(async (tx) => {
      const rows = await tx
        .select({ display_order: videoCourses.displayOrder })
        .from(videoCourses)
        .where(
          and(
            eq(videoCourses.userId, userId),
            sql`${videoCourses.id}=ANY(${sqlNumberArray(courseIds)})`,
          ),
        )
        .orderBy(videoCourses.id)
        .for("update");
      if (
        !courseOrderAllowed(
          {
            validInput: true,
            allSelectedOwned: rows.length === courseIds.length,
          },
          { and: (a, b) => a && b },
        )
      )
        return { mismatch: true } as const;
      // Lock by stable IDs, then sort the current values returned after any lock wait.
      const assignment = planSelectedCourseOrder(
        courseIds,
        rows.map((r) => r.display_order),
        courseArrayOrderPlanning,
      );
      await tx
        .update(videoCourses)
        .set({ displayOrder: sql`desired.slot` })
        .from(
          sql`unnest(${sqlNumberArray(courseIds)},${sqlNumberArray(
            assignment.map((item) => item.slot),
            "int",
          )}) AS desired(gid,slot)`,
        )
        .where(
          and(
            sql`${videoCourses.id}=desired.gid`,
            eq(videoCourses.userId, userId),
            sql`${videoCourses.displayOrder} IS DISTINCT FROM desired.slot`,
          ),
        );
      return { ok: true } as const;
    });
  });
}

export async function courseOwnedBy(
  env: Bindings,
  courseId: number,
  userId: string,
): Promise<boolean> {
  return withDb(env, async (db) => {
    const rows = await db
      .select({ id: videoCourses.id })
      .from(videoCourses)
      .where(
        and(eq(videoCourses.id, courseId), eq(videoCourses.userId, userId)),
      )
      .limit(1);
    return rows.length > 0;
  });
}

/** share_slug を設定する。CI unique 違反(23505)は conflict。 */
export async function setShareSlug(
  env: Bindings,
  courseId: number,
  userId: string,
  slug: string,
): Promise<{ conflict: true } | { notFound: true } | { ok: true }> {
  return withDb(env, async (db) => {
    try {
      const rows = await db
        .update(videoCourses)
        .set({ shareSlug: slug })
        .where(
          and(
            eq(videoCourses.id, courseId),
            eq(videoCourses.userId, userId),
            nativeCourseExternalAccess(),
          ),
        )
        .returning({ id: videoCourses.id });
      return rows.length > 0
        ? ({ ok: true } as const)
        : ({ notFound: true } as const);
    } catch (e) {
      if (isUniqueViolation(e)) return { conflict: true } as const;
      throw e;
    }
  });
}

/** 所有確認と解除を単一SQLで行い、未設定なら更新しない。 */
export async function clearShareSlug(
  env: Bindings,
  courseId: number,
  userId: string,
): Promise<{ notFound: true } | { notConfigured: true } | { ok: true }> {
  return withDb(env, async (db) => {
    const target = db.$with("target").as(
      db
        .select({ id: videoCourses.id, shareSlug: videoCourses.shareSlug })
        .from(videoCourses)
        .where(
          and(eq(videoCourses.id, courseId), eq(videoCourses.userId, userId)),
        )
        .for("update"),
    );
    const cleared = db.$with("cleared").as(
      db
        .update(videoCourses)
        .set({ shareSlug: null })
        .from(target)
        .where(
          and(
            eq(videoCourses.id, target.id),
            sql`coalesce(${target.shareSlug},'')<>''`,
          ),
        )
        .returning({ id: videoCourses.id }),
    );
    const [result] = await db
      .with(target, cleared)
      .select({ cleared: exists(db.select({ id: cleared.id }).from(cleared)) })
      .from(target);
    if (!result) return { notFound: true } as const;
    return result.cleared
      ? ({ ok: true } as const)
      : ({ notConfigured: true } as const);
  });
}

export async function listCoursesPage(
  env: Bindings,
  userId: string,
  limit: number,
  offset: number,
): Promise<{ count: number; results: CourseListItem[] }> {
  return withDb(env, async (db) => {
    const visibleToUser = nativeCourseReadableBy(userId);
    const countRows = await db
      .select({ c: sql<number>`count(*)::int` })
      .from(videoCourses)
      .where(visibleToUser);
    const count = countRows[0].c;
    if (offset >= count) return { count, results: [] };

    const rows = await db
      .select({
        id: videoCourses.id,
        name: videoCourses.name,
        description: videoCourses.description,
        display_order: videoCourses.displayOrder,
        created_at: videoCourses.createdAt,
        video_count: courseVideoCount,
        access_role: courseAuthenticatedRole(
          sql`${videoCourses.userId} = ${userId}`,
          courseDrizzleRoleChoice,
        ),
      })
      .from(videoCourses)
      .where(visibleToUser)
      .orderBy(
        courseOwnerPriority(
          sql`${videoCourses.userId} = ${userId}`,
          courseDrizzlePriorityChoice,
        ),
        asc(videoCourses.displayOrder),
        desc(videoCourses.createdAt),
        asc(videoCourses.id),
      )
      .limit(limit)
      .offset(offset);

    const results: CourseListItem[] = rows.map((r) => ({
      id: Number(r.id),
      name: r.name,
      description: r.description,
      display_order: r.display_order,
      created_at: toUtcIso(r.created_at),
      video_count: r.video_count,
      access_role: r.access_role,
    }));
    return { count, results };
  });
}

export function createPostgresCourseRepository(
  env: Bindings,
): CourseRepository {
  return {
    getInfo: (...args) => getCourseInfo(env, ...args),
    getDetail: (...args) => getCourseDetail(env, ...args),
    getShared: (...args) => getCourseDetailByShareSlug(env, ...args),
    create: (...args) => createCourse(env, ...args),
    update: (...args) => updateCourse(env, ...args),
    delete: (...args) => deleteCourse(env, ...args),
    reorder: (...args) => reorderCourses(env, ...args),
    ownedBy: (...args) => courseOwnedBy(env, ...args),
    setShareSlug: (...args) => setShareSlug(env, ...args),
    clearShareSlug: (...args) => clearShareSlug(env, ...args),
    listPage: (...args) => listCoursesPage(env, ...args),
  };
}
