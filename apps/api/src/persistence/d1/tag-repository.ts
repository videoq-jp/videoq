import {TagNameConflictError} from "../contracts/tag-repository";
import { and, asc, count, eq, sql } from "drizzle-orm";
import { createD1Connection } from "../../db/d1/connection";
import { tags, videos, videoTags } from "../../db/schema/sqlite";
import { mapVideoListRow } from "../../repositories/video-mapping";
import { toUtcIso } from "../../shared/datetime";
import { EMPTY_NAME_MESSAGE, INVALID_COLOR_MESSAGE, normalizeTagName, isValidTagColor } from "../../shared/tag-policy";
import type { Bindings } from "../../types/bindings";
import type { TagListItem, TagRepository } from "../contracts/tag-repository";
import { videoTagsJson } from "./video-read-repository";

const projection = { id: tags.id, name: tags.name, color: tags.color, created_at: tags.createdAt,
  video_count: sql<number>`(SELECT count(*) FROM video_tags vt WHERE vt.tag_id="tags"."id")`.as("video_count") };
const normalize = (row: TagListItem) => ({ ...row, created_at: toUtcIso(row.created_at) });
export function createD1TagRepository(database: D1Database, env: Bindings): TagRepository {
  const db = createD1Connection(database);
  const repository:TagRepository = {
    async listPage(userId, limit, offset) {
      const [totals, rows] = await db.batch([
        db.select({ count: count() }).from(tags).where(eq(tags.userId, userId)),
        db.select(projection).from(tags).where(eq(tags.userId, userId)).orderBy(asc(tags.name)).limit(limit).offset(offset),
      ]);
      return { count: totals[0].count, results: rows.map(normalize) };
    },
    async getDetail(tagId, userId) {
      const [tag] = await db.select(projection).from(tags).where(and(eq(tags.id, tagId), eq(tags.userId, userId))).limit(1);
      if (!tag) return null;
      const rows = await db.select({ id: videos.id, file: videos.file, title: videos.title, description: videos.description,
        uploaded_at: videos.uploadedAt, status: videos.status, source_type: videos.sourceType, source_url: videos.sourceUrl,
        youtube_video_id: videos.youtubeVideoId, tags: videoTagsJson,
      }).from(videoTags).innerJoin(videos, eq(videoTags.videoId, videos.id)).where(eq(videoTags.tagId, tagId)).orderBy(asc(videoTags.id));
      const relatedVideos = await Promise.all(rows.map(row => mapVideoListRow(env, row)));
      return { ...normalize({ ...tag, video_count: relatedVideos.length }), videos: relatedVideos };
    },
    async update(tagId, userId, fields) {
      const name = fields.name === undefined ? undefined : normalizeTagName(fields.name);
      const error = name === null ? EMPTY_NAME_MESSAGE : fields.color !== undefined && !isValidTagColor(fields.color) ? INVALID_COLOR_MESSAGE : null;
      const owned = and(eq(tags.id, tagId), eq(tags.userId, userId));
      if (error) {
        const [tag] = await db.select({ id: tags.id }).from(tags).where(owned).limit(1);
        return tag ? { error } : { notFound: true };
      }
      const rows = name !== undefined || fields.color !== undefined
        ? await db.update(tags).set({ name: name ?? undefined, color: fields.color }).where(owned).returning(projection)
        : await db.select(projection).from(tags).where(owned).limit(1);
      return rows[0] ? { tag: normalize(rows[0]) } : { notFound: true };
    },
    async create(userId, name, color) {
      const [row] = await db.insert(tags).values({ userId, name, color, createdAt: sql`strftime('%Y-%m-%dT%H:%M:%fZ','now')` })
        .returning({ id: tags.id, name: tags.name, color: tags.color, created_at: tags.createdAt });
      return normalize({ ...row, video_count: 0 });
    },
    async delete(tagId, userId) {
      const rows = await db.delete(tags).where(and(eq(tags.id, tagId), eq(tags.userId, userId))).returning({ id: tags.id });
      return rows.length ? { ok: true } : { notFound: true };
    },
  };
  return {...repository,
    create:(...args)=>repository.create(...args).catch(normalizeTagNameConflict),
    update:(...args)=>repository.update(...args).catch(normalizeTagNameConflict),
  };
}

function normalizeTagNameConflict(error:unknown):never {
 let cause=error;
 for(let depth=0;depth<4&&cause instanceof Error;depth++){
  if(/UNIQUE constraint failed: tags\.(?:name, tags\.user_id|user_id, tags\.name)(?:$|:)/.test(cause.message))throw new TagNameConflictError();
  cause=cause.cause;
 }
 throw error;
}
