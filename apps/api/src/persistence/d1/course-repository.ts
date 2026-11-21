import { QueryBuilder } from "drizzle-orm/sqlite-core";
import {
  insertSelectValues,
  insertSelectFields,
  runD1Batch,
  withMaterializedCtes,
} from "../../db/d1/query-builders";
import {
  courseEditable,
  validCourseOrderInput,
  courseOrderAllowed,
  courseAccessRole,
  courseAuthenticatedRole,
  courseOwnerPriority,
} from "../../application/course-management";
import {
  courseManagementDrizzleLogic,
  courseDrizzleRoleChoice,
  courseDrizzlePriorityChoice,
} from "../course-management-policy-sql";
import { nativeCourseAccessAllowed } from "../../application/native-course-access";
import { nativeCourseDrizzleLogic } from "../native-course-policy-sql";
import {
  and,
  asc,
  desc,
  eq,
  sql,
  exists,
  notExists,
  inArray,
  type SQL,
} from "drizzle-orm";
import { videoStatusSchema } from "@videoq/trpc";
import { createD1Connection } from "../../db/d1/connection";
import {
  videoCourses,
  videos,
  videoCourseMembers,
  videoCourseMemberships,
  mcpIdempotencyRecords as records,
} from "../../db/schema/sqlite";
import { mapVideoListRow } from "../../repositories/video-mapping";
import { toUtcIso } from "../../shared/datetime";
import type { Bindings } from "../../types/bindings";
import type {
  CourseRepository,
  CourseDetail,
  CourseReadOptions,
} from "../contracts/course-repository";
import { nativeCourseExternalAccess } from "./course-access";
import { videoListProjection } from "./video-read-repository";
const NOW = sql<string>`strftime('%Y-%m-%dT%H:%M:%fZ','now')`;
const builder = new QueryBuilder();
const external = nativeCourseExternalAccess();
const count = sql<number>`(${builder
  .select({ value: sql`count(*)` })
  .from(videoCourseMembers)
  .where(eq(videoCourseMembers.courseId, videoCourses.id))})`.as("video_count");
const projection = {
  id: videoCourses.id,
  name: videoCourses.name,
  description: videoCourses.description,
  display_order: videoCourses.displayOrder,
  created_at: videoCourses.createdAt,
  updated_at: videoCourses.updatedAt,
  share_slug: videoCourses.shareSlug,
  video_count: count,
  owner_user_id: videoCourses.userId,
};
const owned = (id: number, userId: string) =>
  and(eq(videoCourses.id, id), eq(videoCourses.userId, userId));
const editable = (id: number, userId: string) =>
  and(
    eq(videoCourses.id, id),
    courseEditable(
      sql`${videoCourses.userId}=${userId}`,
      sql`${videoCourses.managedByLms}=0`,
      courseManagementDrizzleLogic,
    ),
  )!;
const readable = (userId: string) =>
  nativeCourseAccessAllowed(
    false,
    {
      owner: sql`${videoCourses.userId}=${userId}`,
      nativeEnabled: external,
      participant: exists(
        builder
          .select({ id: videoCourseMemberships.id })
          .from(videoCourseMemberships)
          .where(
            and(
              eq(videoCourseMemberships.courseId, videoCourses.id),
              eq(videoCourseMemberships.userId, userId),
            ),
          ),
      ),
      shareMatches: sql`0`,
    },
    nativeCourseDrizzleLogic,
  );
type Metadata = {
  id: number;
  name: string;
  description: string;
  display_order: number;
  created_at: string;
  updated_at: string;
  share_slug: string | null;
  video_count: number;
  owner_user_id: string;
};
export function createD1CourseRepository(
  database: D1Database,
  env: Bindings,
): CourseRepository {
  const db = createD1Connection(database);
  const members = (where: SQL, options: CourseReadOptions) =>
    db
      .select({
        ...videoListProjection,
        tags:
          options.includeTags === false
            ? sql<string>`'[]'`.as("tags")
            : videoListProjection.tags,
        member_order: videoCourseMembers.order,
      })
      .from(videoCourseMembers)
      .innerJoin(videos, eq(videos.id, videoCourseMembers.videoId))
      .innerJoin(videoCourses, eq(videoCourses.id, videoCourseMembers.courseId))
      .where(where)
      .orderBy(
        asc(videoCourseMembers.order),
        asc(videoCourseMembers.addedAt),
        asc(videoCourseMembers.id),
      )
      .limit(options.videoLimit ?? Number.MAX_SAFE_INTEGER)
      .offset(options.videoOffset ?? 0);
  async function detail(
    course: Metadata,
    rows: Awaited<ReturnType<typeof members>>,
    viewer: "public" | { viewerUserId: string },
    options: CourseReadOptions,
  ): Promise<CourseDetail> {
    return {
      id: course.id,
      name: course.name,
      description: course.description,
      display_order: course.display_order,
      created_at: toUtcIso(course.created_at),
      updated_at: toUtcIso(course.updated_at),
      share_slug: course.share_slug,
      video_count: course.video_count,
      access_role: courseAccessRole(viewer, course.owner_user_id),
      videos: await Promise.all(
        rows.map(async (row) => ({
          ...(await mapVideoListRow(env, row, {
            includeFileUrl: options.includeFileUrls !== false,
          })),
          order: row.member_order,
        })),
      ),
    };
  }
  async function fetchDetail(
    where: SQL,
    viewer: "public" | { viewerUserId: string },
    options: CourseReadOptions,
  ) {
    const [courses, rows] = await db.batch([
      db.select(projection).from(videoCourses).where(where).limit(1),
      members(where, options),
    ]);
    return courses[0] ? detail(courses[0], rows, viewer, options) : null;
  }
  return {
    async getInfo(courseId, ownerUserId, options) {
      const where = owned(courseId, ownerUserId)!;
      const videoFilter =
        options.videoIds === undefined
          ? undefined
          : inArray(
              videos.id,
              db
                .select({ id: sql<number>`value` })
                .from(sql`json_each(${JSON.stringify(options.videoIds)})`),
            );
      const visibleCount =
        options.videoIds === undefined
          ? count
          : sql<number>`(${db
              .select({ value: sql`count(*)` })
              .from(videoCourseMembers)
              .where(
                and(
                  eq(videoCourseMembers.courseId, videoCourses.id),
                  inArray(
                    videoCourseMembers.videoId,
                    db
                      .select({ id: sql<number>`value` })
                      .from(
                        sql`json_each(${JSON.stringify(options.videoIds)})`,
                      ),
                  ),
                ),
              )})`.as("video_count");
      const [courses, rows] = await db.batch([
        db
          .select({
            name: videoCourses.name,
            description: sql<string>`substr(${videoCourses.description},1,${options.courseDescriptionLimit + 1})`,
            video_count: visibleCount,
          })
          .from(videoCourses)
          .where(where)
          .limit(1),
        db
          .select({
            id: videos.id,
            title: videos.title,
            description: sql<string>`substr(${videos.description},1,${options.videoDescriptionLimit + 1})`,
            status: videos.status,
            order: videoCourseMembers.order,
          })
          .from(videoCourseMembers)
          .innerJoin(videos, eq(videos.id, videoCourseMembers.videoId))
          .innerJoin(
            videoCourses,
            eq(videoCourses.id, videoCourseMembers.courseId),
          )
          .where(and(where, videoFilter))
          .orderBy(
            asc(videoCourseMembers.order),
            asc(videoCourseMembers.addedAt),
            asc(videoCourseMembers.id),
          )
          .limit(options.videoLimit)
          .offset(options.videoOffset),
      ]);
      return courses[0]
        ? {
            ...courses[0],
            videos: rows.map((row) => ({
              ...row,
              status: videoStatusSchema.parse(row.status),
            })),
          }
        : null;
    },
    getDetail: (id, userId, options = {}) =>
      fetchDetail(
        and(eq(videoCourses.id, id), readable(userId))!,
        { viewerUserId: userId },
        options,
      ),
    getShared: (slug, options = {}) =>
      fetchDetail(
        and(eq(videoCourses.shareSlug, slug), external)!,
        "public",
        options,
      ),
    async create(userId, name, description, idempotency) {
      const identity = idempotency ?? {
        action: "create_course",
        key: `internal:${crypto.randomUUID()}`,
        requestHash: "0".repeat(64),
      };
      const identityMatches = and(
        eq(records.userId, userId),
        eq(records.action, identity.action),
        eq(records.key, identity.key),
      );
      const nextSlot = db
        .select({
          value: sql`coalesce(max(${videoCourses.displayOrder}),-1)+1`,
        })
        .from(videoCourses)
        .where(eq(videoCourses.userId, userId));
      const results = await runD1Batch<{
        resource_id: number;
        request_hash: string;
        created: number;
      }>(database, [
        db.insert(videoCourses).select(
          db
            .select(
              insertSelectValues(videoCourses, {
                userId,
                name,
                description,
                displayOrder: sql`(${nextSlot})`,
                createdAt: NOW,
                updatedAt: NOW,
                shareSlug: null,
              }),
            )
            .from(sql`json_each('[0]')`)
            .where(
              notExists(
                db
                  .select({ key: records.key })
                  .from(records)
                  .where(identityMatches),
              ),
            ),
        ),
        db.insert(records).select(
          db
            .select(
              insertSelectFields(records, {
                userId: sql`${userId}`,
                action: sql`${identity.action}`,
                key: sql`${identity.key}`,
                requestHash: sql`${identity.requestHash}`,
                resourceId: sql`last_insert_rowid()`,
              }),
            )
            .from(sql`json_each('[0]')`)
            .where(sql`changes()=1`),
        ),
        db
          .select({
            resourceId: records.resourceId,
            requestHash: records.requestHash,
            created: sql<number>`changes()`.as("created"),
          })
          .from(records)
          .where(identityMatches),
        db
          .delete(records)
          .where(and(identityMatches, sql`${idempotency ? 1 : 0}=0`)),
      ]);
      const row = results[2].results[0];
      if (!row) throw new Error("Missing created course");
      return row.request_hash !== identity.requestHash
        ? { idempotencyConflict: true }
        : { ok: true, courseId: row.resource_id, reused: !row.created };
    },
    async update(id, userId, fields) {
      const where = editable(id, userId),
        options = { includeTags: false };
      const query =
        fields.name !== undefined || fields.description !== undefined
          ? db
              .update(videoCourses)
              .set({ name: fields.name, description: fields.description })
              .where(where)
              .returning(projection)
          : db.select(projection).from(videoCourses).where(where).limit(1);
      const [courses, rows] = await db.batch([query, members(where, options)]);
      return courses[0]
        ? {
            course: await detail(
              courses[0],
              rows,
              { viewerUserId: userId },
              options,
            ),
          }
        : { notFound: true };
    },
    async delete(id, userId) {
      const results = await runD1Batch(database, [
        db
          .delete(records)
          .where(
            and(
              eq(records.userId, userId),
              eq(records.action, "create_course"),
              eq(records.resourceId, id),
              exists(
                db
                  .select({ id: videoCourses.id })
                  .from(videoCourses)
                  .where(editable(id, userId)),
              ),
            ),
          ),
        db
          .delete(videoCourses)
          .where(editable(id, userId))
          .returning({ id: videoCourses.id }),
      ]);
      return results[1].results.length ? { ok: true } : { notFound: true };
    },
    async reorder(userId, ids) {
      if (!validCourseOrderInput(ids)) return { mismatch: true };
      const encoded = JSON.stringify(ids);
      const requestedIds = db
        .select({ id: sql<number>`value` })
        .from(sql`json_each(${encoded})`);
      const selected = and(
        eq(videoCourses.userId, userId),
        inArray(videoCourses.id, requestedIds),
      );
      const selectedCount = db
        .select({ n: sql`count(*)` })
        .from(videoCourses)
        .where(selected);
      const permitted = courseOrderAllowed(
        {
          validInput: sql`1`,
          allSelectedOwned: sql`(${selectedCount})=${ids.length}`,
        },
        courseManagementDrizzleLogic,
      );
      const slotsQuery = db
        .select({
          displayOrder: videoCourses.displayOrder,
          ordinal:
            sql<number>`row_number() OVER(ORDER BY ${videoCourses.displayOrder},${videoCourses.id})-1`.as(
              "ordinal",
            ),
        })
        .from(videoCourses)
        .where(selected);
      const slots = db.$with("slots").as(slotsQuery);
      const desiredQuery = db
        .select({
          id: sql<number>`input.value`.as("id"),
          displayOrder: slots.displayOrder,
        })
        .from(sql`json_each(${encoded}) input`)
        .innerJoin(slots, sql`${slots.ordinal}=CAST(input.key AS INT)`);
      const desired = db.$with("desired").as(desiredQuery);
      const assigned = db
        .select({ slot: desired.displayOrder })
        .from(desired)
        .where(eq(desired.id, videoCourses.id));
      const result = await runD1Batch<{ allowed: number }>(database, [
        db
          .select({ allowed: permitted.as("allowed") })
          .from(sql`json_each('[0]')`),
        withMaterializedCtes(
          [
            { name: "slots", source: slotsQuery },
            { name: "desired", source: desiredQuery },
          ],
          db
            .update(videoCourses)
            .set({ displayOrder: sql`(${assigned})` })
            .where(
              and(
                eq(videoCourses.userId, userId),
                inArray(
                  videoCourses.id,
                  db.select({ id: desired.id }).from(desired),
                ),
                permitted,
                sql`${videoCourses.displayOrder}<>(${assigned})`,
              ),
            ),
        ),
      ]);
      return result[0].results[0].allowed ? { ok: true } : { mismatch: true };
    },
    async ownedBy(id, userId) {
      return Boolean(
        (
          await db
            .select({ id: videoCourses.id })
            .from(videoCourses)
            .where(owned(id, userId))
            .limit(1)
        )[0],
      );
    },
    async setShareSlug(id, userId, slug) {
      try {
        const rows = await db
          .update(videoCourses)
          .set({ shareSlug: slug })
          .where(and(owned(id, userId), external))
          .returning({ id: videoCourses.id });
        return rows.length ? { ok: true } : { notFound: true };
      } catch (error) {
        const cause =
          error instanceof Error && error.cause ? error.cause : error;
        if (
          cause instanceof Error &&
          /UNIQUE constraint failed.*video_courses_share_slug_ci_uniq/.test(
            cause.message,
          )
        )
          return { conflict: true };
        throw error;
      }
    },
    async clearShareSlug(id, userId) {
      const result = await runD1Batch(database, [
        db
          .select({ id: videoCourses.id })
          .from(videoCourses)
          .where(owned(id, userId)),
        db
          .update(videoCourses)
          .set({ shareSlug: null })
          .where(
            and(
              owned(id, userId),
              sql`coalesce(${videoCourses.shareSlug},'')<>''`,
            ),
          )
          .returning({ id: videoCourses.id }),
      ]);
      return !result[0].results.length
        ? { notFound: true }
        : result[1].results.length
          ? { ok: true }
          : { notConfigured: true };
    },
    async listPage(userId, limit, offset) {
      const where = readable(userId),
        role = courseAuthenticatedRole(
          sql`${videoCourses.userId}=${userId}`,
          courseDrizzleRoleChoice,
        );
      const [totals, rows] = await db.batch([
        db
          .select({ count: sql<number>`count(*)` })
          .from(videoCourses)
          .where(where),
        db
          .select({
            id: videoCourses.id,
            name: videoCourses.name,
            description: videoCourses.description,
            display_order: videoCourses.displayOrder,
            created_at: videoCourses.createdAt,
            video_count: count,
            access_role: role,
          })
          .from(videoCourses)
          .where(where)
          .orderBy(
            courseOwnerPriority(
              sql`${videoCourses.userId}=${userId}`,
              courseDrizzlePriorityChoice,
            ),
            asc(videoCourses.displayOrder),
            desc(videoCourses.createdAt),
            asc(videoCourses.id),
          )
          .limit(limit)
          .offset(offset),
      ]);
      return {
        count: totals[0].count,
        results: rows.map((row) => ({
          ...row,
          created_at: toUtcIso(row.created_at),
        })),
      };
    },
  };
}
