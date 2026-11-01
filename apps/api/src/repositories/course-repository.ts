import { and, asc, desc, eq, or, type SQL, sql } from "drizzle-orm";
import { videoStatusSchema } from "@videoq/trpc";
import { type Db, withClient, withDb } from "../db/pool";
import { isUniqueViolation } from "../db/errors";
import { sqlNumberArray } from "../db/sql-array";
import {
  mcpIdempotencyRecords,
  videos,
  videoCourses,
  videoCourseMembers,
  videoCourseMemberships,
} from "../db/schema";
import { toUtcIso } from "../shared/datetime";
import { mapVideoListRow, videoTagsJson, visualProcessing, type VideoListItem } from "./video-repository";
import type { Bindings } from "../types/bindings";
import {
  findIdempotentResource,
  recordIdempotentResource,
  type CreationIdempotency,
} from "./mcp-idempotency-repository";

/** VideoCourse 一覧 API のレスポンス表現。 */
export type CourseListItem = {
  id: number;
  name: string;
  description: string;
  display_order: number;
  created_at: string;
  video_count: number;
  access_role: "owner" | "member";
};

/**
 * ユーザーの講座一覧（ページ）+ 総数を単一接続で取得。
 * 並び: display_order ASC, created_at DESC, id ASC。
 * video_count は所属する動画の件数。
 */
// VideoCourseDetailSerializer: 一覧 + updated_at / share_slug / videos（ネスト）
export type CourseDetail = {
  id: number;
  name: string;
  description: string;
  display_order: number;
  created_at: string;
  updated_at: string;
  video_count: number;
  share_slug: string | null;
  videos: (VideoListItem & { order: number })[];
  access_role: "owner" | "member" | "public";
};

// Must be "video_courses"."id": ${videoCourses.id} becomes bare "id" → m.id.
// The (course_id, video_id) unique constraint already prevents duplicates.
const courseVideoCount = sql<number>`(SELECT count(*)::int FROM video_course_members m WHERE m.course_id = "video_courses"."id")`.as(
  "video_count",
);

export type CourseInfo = Pick<CourseDetail, "name" | "description" | "video_count"> & {
  videos: Pick<CourseDetail["videos"][number], "id" | "title" | "description" | "status" | "order">[];
};

type CourseReadOptions = {
  includeFileUrls?: boolean;
  /** Web の講座レスポンスはタグを含めない。MCP は既定の集計を使う。 */
  includeTags?: boolean;
  videoLimit?: number;
  videoOffset?: number;
};

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
  },
): Promise<CourseInfo | null> {
  return withDb(env, async (db) => {
    // PostgreSQL counts code points; one extra preserves the caller's UTF-16
    // slice/length checks even when the description contains surrogate pairs.
    const [course] = await db
      .select({
        name: videoCourses.name,
        description: sql<string>`left(${videoCourses.description}, ${options.courseDescriptionLimit + 1})`.as("description"),
        video_count: courseVideoCount,
      })
      .from(videoCourses)
      .where(and(eq(videoCourses.id, courseId), eq(videoCourses.userId, ownerUserId)))
      .limit(1);
    if (!course) return null;
    if (options.videoOffset >= course.video_count) return { ...course, videos: [] };
    const members = await db
      .select({
        id: videos.id,
        title: videos.title,
        description: sql<string>`left(${videos.description}, ${options.videoDescriptionLimit + 1})`.as("description"),
        status: videos.status,
        member_order: videoCourseMembers.order,
      })
      .from(videoCourseMembers)
      .innerJoin(videos, eq(videos.id, videoCourseMembers.videoId))
      .where(eq(videoCourseMembers.courseId, courseId))
      .orderBy(asc(videoCourseMembers.order), asc(videoCourseMembers.addedAt), asc(videoCourseMembers.id))
      .limit(options.videoLimit)
      .offset(options.videoOffset);
    return {
      ...course,
      videos: members.map((row) => ({
        id: Number(row.id), title: row.title, description: row.description,
        status: videoStatusSchema.parse(row.status), order: row.member_order,
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

type CourseMetadata = Omit<CourseDetail, "videos" | "access_role"> & { owner_user_id: string };

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
      tags: options.includeTags === false ? sql<string>`'[]'`.as("tags") : videoTagsJson,
      visual_processing: visualProcessing,
    })
    .from(videoCourseMembers)
    .innerJoin(videos, eq(videos.id, videoCourseMembers.videoId))
    .where(eq(videoCourseMembers.courseId, course.id))
    .orderBy(asc(videoCourseMembers.order), asc(videoCourseMembers.addedAt), asc(videoCourseMembers.id))
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
  data: { course: CourseMetadata; members: Awaited<ReturnType<typeof readCourseMembers>> },
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
    access_role:
      accessRole === "public"
        ? "public"
        : g.owner_user_id === accessRole.viewerUserId
          ? "owner"
          : "member",
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
    const [course] = await db.select(courseDetailSelect).from(videoCourses).where(where).limit(1);
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
    and(
      eq(videoCourses.id, courseId),
      or(
        eq(videoCourses.userId, userId),
        sql`EXISTS (
          SELECT 1 FROM ${videoCourseMemberships}
           WHERE ${videoCourseMemberships.courseId} = ${videoCourses.id}
             AND ${videoCourseMemberships.userId} = ${userId}
        )`,
      ),
    )!,
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
  return fetchCourseDetail(env, eq(videoCourses.shareSlug, shareSlug), "public", options);
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
      await tx.execute(sql`SELECT 1 FROM users WHERE id = ${userId} FOR UPDATE`);
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
          displayOrder: sql`(SELECT COALESCE(MAX(display_order), -1) + 1 FROM video_courses WHERE user_id = ${userId})`,
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
  const data = await withDb(env, (db) => db.transaction(async (tx) => {
    const patch: { name?: string; description?: string } = {};
    if (fields.name !== undefined) patch.name = fields.name;
    if (fields.description !== undefined) patch.description = fields.description;
    const where = and(eq(videoCourses.id, courseId), eq(videoCourses.userId, userId));
    const [course] = Object.keys(patch).length > 0
      ? await tx.update(videoCourses).set(patch).where(where).returning(courseDetailSelect)
      : await tx.select(courseDetailSelect).from(videoCourses).where(where).for("update").limit(1);
    if (!course) return null;
    return { course, members: await readCourseMembers(tx, course, options) };
  }));
  if (!data) return { notFound: true };
  return { course: await mapCourseDetail(env, data, { viewerUserId: userId }, options) };
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
        .where(and(eq(videoCourses.id, courseId), eq(videoCourses.userId, userId)))
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
        .where(and(eq(videoCourses.id, courseId), eq(videoCourses.userId, userId)));
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
  if (courseIds.length === 0) return { mismatch: true } as const;
  if (new Set(courseIds).size !== courseIds.length) return { mismatch: true } as const;

  return withDb(env, async (db) => {
    return db.transaction(async (tx) => {
      const sel = await tx.execute(sql`
        SELECT display_order FROM video_courses
         WHERE user_id = ${userId} AND id = ANY(${sqlNumberArray(courseIds)})
         ORDER BY id ASC
         FOR UPDATE
      `);
      const rows = sel.rows as Array<{ display_order: number }>;
      if (rows.length !== courseIds.length) return { mismatch: true } as const;
      // Lock by stable IDs, then sort the current values returned after any lock wait.
      const slots = rows.map((r) => r.display_order).sort((a, b) => a - b);
      await tx.execute(sql`
        UPDATE video_courses AS g SET display_order = d.slot
          FROM unnest(${sqlNumberArray(courseIds)}, ${sqlNumberArray(slots, "int")}) AS d(gid, slot)
         WHERE g.id = d.gid AND g.user_id = ${userId}
           AND g.display_order IS DISTINCT FROM d.slot
      `);
      return { ok: true } as const;
    });
  });
}

/**
 * Lock the owned course and current members before validating the complete order.
 * Member locks also serialize video deletions that cascade without locking the course.
 */
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
        .where(and(eq(videoCourses.id, courseId), eq(videoCourses.userId, userId)))
        .for("update");
      if (owner.length === 0) return { notFound: true } as const;

      const members = await tx
        .select({ videoId: videoCourseMembers.videoId })
        .from(videoCourseMembers)
        .where(eq(videoCourseMembers.courseId, courseId))
        .orderBy(asc(videoCourseMembers.videoId))
        .for("update");
      const memberIds = new Set(members.map(member => member.videoId));
      if (
        videoIds.length !== members.length ||
        new Set(videoIds).size !== videoIds.length ||
        videoIds.some(id => !memberIds.has(id))
      ) return { mismatch: true } as const;

      if (videoIds.length > 0) {
        await tx.execute(sql`
          UPDATE video_course_members AS m SET "order" = v.ord - 1
            FROM unnest(${sqlNumberArray(videoIds)}) WITH ORDINALITY AS v(video_id, ord)
           WHERE m.course_id = ${courseId} AND m.video_id = v.video_id
             AND m."order" IS DISTINCT FROM v.ord - 1
        `);
      }
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
      .where(and(eq(videoCourses.id, courseId), eq(videoCourses.userId, userId)))
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
        .where(and(eq(videoCourses.id, courseId), eq(videoCourses.userId, userId)))
        .returning({ id: videoCourses.id });
      return rows.length > 0 ? { ok: true } as const : { notFound: true } as const;
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
  return withClient(env, async (client) => {
    // ロック待ちの間に解除・削除・所有者変更されても、最新の行で判定する。
    const { rows: [result] } = await client.query<{ found: boolean; cleared: boolean }>(`
      WITH target AS (
        SELECT id, share_slug FROM video_courses
         WHERE id = $1 AND user_id = $2
         FOR UPDATE
      ), cleared AS (
        UPDATE video_courses SET share_slug = NULL
          FROM target
         WHERE video_courses.id = target.id
           AND COALESCE(target.share_slug, '') <> ''
        RETURNING video_courses.id
      )
      SELECT EXISTS(SELECT 1 FROM target) AS found,
             EXISTS(SELECT 1 FROM cleared) AS cleared
    `, [courseId, userId]);
    if (!result.found) return { notFound: true } as const;
    return result.cleared ? { ok: true } as const : { notConfigured: true } as const;
  });
}

export async function listCoursesPage(
  env: Bindings,
  userId: string,
  limit: number,
  offset: number,
): Promise<{ count: number; results: CourseListItem[] }> {
  return withDb(env, async (db) => {
    const visibleToUser = or(
      eq(videoCourses.userId, userId),
      sql`EXISTS (
        SELECT 1 FROM ${videoCourseMemberships}
         WHERE ${videoCourseMemberships.courseId} = ${videoCourses.id}
           AND ${videoCourseMemberships.userId} = ${userId}
      )`,
    );
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
        access_role: sql<"owner" | "member">`CASE
          WHEN ${videoCourses.userId} = ${userId} THEN 'owner'
          ELSE 'member'
        END`,
      })
      .from(videoCourses)
      .where(visibleToUser)
      .orderBy(
        sql`CASE WHEN ${videoCourses.userId} = ${userId} THEN 0 ELSE 1 END`,
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
