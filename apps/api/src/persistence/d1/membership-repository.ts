import { and, eq, exists, notExists, sql, inArray } from "drizzle-orm";
import { createD1Connection } from "../../db/d1/connection";
import { insertSelectFields, runD1Batch } from "../../db/d1/query-builders";
import {
  videos,
  tags,
  videoTags,
  videoCourses,
  videoCourseMembers as members,
} from "../../db/schema/sqlite";
import {
  uniqueMembershipIds,
  tagAttachmentAllowed,
  membershipCourseAllowed,
  membershipVideoAllowed,
  membershipOrderAllowed,
} from "../../application/membership-policy";
import { membershipDrizzleLogic } from "../membership-policy-sql";
import type { MembershipRepository } from "../contracts/membership-repository";

export function createD1MembershipRepository(
  database: D1Database,
): MembershipRepository {
  const db = createD1Connection(database),
    oneRow = sql`json_each('[0]')`,
    now = sql`strftime('%Y-%m-%dT%H:%M:%fZ','now')`;
  const idsQuery = (ids: readonly number[]) =>
    db
      .select({ id: sql<number>`value` })
      .from(sql`json_each(${JSON.stringify(ids)})`);
  const ownsVideo = (id: number, user: string) =>
    exists(
      db
        .select({ id: videos.id })
        .from(videos)
        .where(and(eq(videos.id, id), eq(videos.userId, user))),
    );
  const ownsCourse = (id: number, user: string) =>
    exists(
      db
        .select({ id: videoCourses.id })
        .from(videoCourses)
        .where(
          and(
            eq(videoCourses.id, id),
            membershipCourseAllowed(
              {
                owned: eq(videoCourses.userId, user),
                native: eq(videoCourses.managedByLms, false),
              },
              membershipDrizzleLogic,
            ),
          ),
        ),
    );
  const allowedVideos = (
    ids: number[],
    user: string,
    operation: "add" | "remove" = "add",
  ) => {
    const count = db
      .select({ n: sql`count(*)` })
      .from(videos)
      .where(
        and(
          inArray(videos.id, idsQuery(ids)),
          membershipVideoAllowed(
            operation,
            {
              owned: eq(videos.userId, user),
              native: eq(videos.managedByLms, false),
            },
            membershipDrizzleLogic,
          ),
        ),
      );
    return sql`(${count})=${ids.length}`;
  };
  const existingMember = (courseId: number, videoId: number) =>
    db
      .select({ id: members.id })
      .from(members)
      .where(and(eq(members.courseId, courseId), eq(members.videoId, videoId)));
  const nextSlot = (courseId: number) =>
    db
      .select({ n: sql`coalesce(max(${members.order}),-1)` })
      .from(members)
      .where(eq(members.courseId, courseId));
  return {
    async reorderVideos(courseId, userId, videoIds) {
      const input = sql`json_each(${JSON.stringify(videoIds)}) input`;
      const size = db
        .select({ n: sql`count(*)` })
        .from(members)
        .where(eq(members.courseId, courseId));
      const unique = db
        .select({ n: sql`count(DISTINCT input.value)` })
        .from(input);
      const matched = membershipOrderAllowed(
        {
          sameSize: sql`(${size})=${videoIds.length}`,
          unique: sql`(${unique})=${videoIds.length}`,
          allMembers: notExists(
            db
              .select({ id: sql`input.value` })
              .from(input)
              .where(
                notExists(
                  db
                    .select({ id: members.id })
                    .from(members)
                    .where(
                      and(
                        eq(members.courseId, courseId),
                        sql`${members.videoId}=input.value`,
                      ),
                    ),
                ),
              ),
          ),
        },
        membershipDrizzleLogic,
      );
      const owned = ownsCourse(courseId, userId);
      const slot = db
        .select({ slot: sql`CAST(input.key AS INTEGER)` })
        .from(input)
        .where(sql`input.value=${members.videoId}`);
      const result = await runD1Batch<{ owned: number; matched: number }>(
        database,
        [
          db
            .select({
              owned: owned.as("owned"),
              matched: matched.as("matched"),
            })
            .from(oneRow),
          db
            .update(members)
            .set({ order: sql`(${slot})` })
            .where(
              and(
                eq(members.courseId, courseId),
                owned,
                matched,
                sql`${members.order}<>(${slot})`,
              ),
            ),
        ],
      );
      const row = result[0].results[0];
      return !row.owned
        ? { notFound: true }
        : row.matched
          ? { ok: true }
          : { mismatch: true };
    },
    async attachTags(videoId, userId, tagIds) {
      const ids = uniqueMembershipIds(tagIds),
        owned = ownsVideo(videoId, userId);
      const linked = exists(
        db
          .select({ id: videoTags.id })
          .from(videoTags)
          .where(
            and(eq(videoTags.videoId, videoId), eq(videoTags.tagId, tags.id)),
          ),
      );
      const eligible = db
        .select({ n: sql`count(*)` })
        .from(tags)
        .where(
          and(
            inArray(tags.id, idsQuery(ids)),
            tagAttachmentAllowed(
              { owned: eq(tags.userId, userId), alreadyLinked: linked },
              membershipDrizzleLogic,
            ),
          ),
        );
      const allowed = sql`(${eligible})=${ids.length}`;
      const result = await runD1Batch<{
        owned: number;
        allowed: number;
        id: number;
      }>(database, [
        db
          .select({ owned: owned.as("owned"), allowed: allowed.as("allowed") })
          .from(oneRow),
        db
          .insert(videoTags)
          .select(
            db
              .select(
                insertSelectFields(videoTags, {
                  videoId: sql`${videoId}`,
                  tagId: tags.id,
                  addedAt: now,
                }),
              )
              .from(tags)
              .where(
                and(
                  inArray(tags.id, idsQuery(ids)),
                  owned,
                  allowed,
                  sql`NOT (${linked})`,
                ),
              ),
          )
          .onConflictDoNothing({ target: [videoTags.tagId, videoTags.videoId] })
          .returning({ id: videoTags.id }),
      ]);
      if (!result[0].results[0].owned) return { notFound: "Video not found" };
      if (!result[0].results[0].allowed)
        return { notFound: "Resource not found" };
      return { added: result[1].results.length };
    },
    async detachTag(videoId, tagId, userId) {
      const owned = ownsVideo(videoId, userId),
        tag = exists(
          db
            .select({ id: tags.id })
            .from(tags)
            .where(and(eq(tags.id, tagId), eq(tags.userId, userId))),
        );
      const result = await runD1Batch<{
        owned: number;
        tag: number;
        id: number;
      }>(database, [
        db
          .select({ owned: owned.as("owned"), tag: tag.as("tag") })
          .from(oneRow),
        db
          .delete(videoTags)
          .where(
            and(
              eq(videoTags.videoId, videoId),
              eq(videoTags.tagId, tagId),
              owned,
              tag,
            ),
          )
          .returning({ id: videoTags.id }),
      ]);
      if (!result[0].results[0].owned) return { notFound: "Video not found" };
      if (!result[0].results[0].tag) return { notFound: "Tag not found" };
      return result[1].results.length
        ? { ok: true }
        : { notFound: "Resource not found" };
    },
    async addVideoToCourse(courseId, videoId, userId) {
      const owned = ownsCourse(courseId, userId),
        allowed = allowedVideos([videoId], userId),
        existing = existingMember(courseId, videoId);
      const result = await runD1Batch<{
        owned: number;
        allowed: number;
        existing: number | null;
        id: number;
      }>(database, [
        db
          .select({
            owned: owned.as("owned"),
            allowed: allowed.as("allowed"),
            existing: sql<number | null>`(${existing})`.as("existing"),
          })
          .from(oneRow),
        db
          .insert(members)
          .select(
            db
              .select(
                insertSelectFields(members, {
                  courseId: sql`${courseId}`,
                  videoId: sql`${videoId}`,
                  order: sql`(${nextSlot(courseId)})+1`,
                  addedAt: now,
                }),
              )
              .from(oneRow)
              .where(and(owned, allowed, notExists(existing))),
          )
          .returning({ id: members.id }),
      ]);
      const row = result[0].results[0];
      if (!row.owned) return { notFound: "Course not found" };
      if (!row.allowed) return { notFound: "Video not found" };
      return row.existing !== null
        ? { alreadyIn: true, id: row.existing }
        : { id: result[1].results[0].id };
    },
    async removeVideoFromCourse(courseId, videoId, userId) {
      const owned = ownsCourse(courseId, userId),
        allowed = allowedVideos([videoId], userId, "remove");
      const result = await runD1Batch<{
        owned: number;
        allowed: number;
        id: number;
      }>(database, [
        db
          .select({ owned: owned.as("owned"), allowed: allowed.as("allowed") })
          .from(oneRow),
        db
          .delete(members)
          .where(
            and(
              eq(members.courseId, courseId),
              eq(members.videoId, videoId),
              owned,
              allowed,
            ),
          )
          .returning({ id: members.id }),
      ]);
      const row = result[0].results[0];
      if (!row.owned) return { notFound: "Course not found" };
      if (!row.allowed) return { notFound: "Video not found" };
      return result[1].results.length ? { ok: true } : { notMember: true };
    },
    async addVideosBulk(courseId, videoIds, userId) {
      const ids = uniqueMembershipIds(videoIds),
        owned = ownsCourse(courseId, userId),
        allowed = allowedVideos(ids, userId);
      const input = sql`json_each(${JSON.stringify(ids)}) input`;
      const existing = db
        .select({ id: members.id })
        .from(members)
        .where(
          and(
            eq(members.courseId, courseId),
            sql`${members.videoId}=input.value`,
          ),
        );
      const result = await runD1Batch<{
        owned: number;
        allowed: number;
        id: number;
      }>(database, [
        db
          .select({ owned: owned.as("owned"), allowed: allowed.as("allowed") })
          .from(oneRow),
        db
          .insert(members)
          .select(
            db
              .select(
                insertSelectFields(members, {
                  courseId: sql`${courseId}`,
                  videoId: sql`input.value`,
                  order: sql`(${nextSlot(courseId)})+row_number() OVER(ORDER BY CAST(input.key AS INTEGER))`,
                  addedAt: now,
                }),
              )
              .from(input)
              .where(and(owned, allowed, notExists(existing))),
          )
          .returning({ id: members.id }),
      ]);
      const row = result[0].results[0];
      if (!row.owned) return { notFound: "Course not found" };
      if (!row.allowed) return { notFound: "Some videos not found" };
      return { added: result[1].results.length };
    },
  };
}
