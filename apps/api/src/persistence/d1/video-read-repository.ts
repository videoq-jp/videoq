import { and, asc, desc, eq, inArray, sql, type SQL } from "drizzle-orm";
import { visualProcessingSchema } from "@videoq/trpc/schema";
import { createD1Connection } from "../../db/d1/connection";
import { videos, videoTags } from "../../db/schema/sqlite";
import { mapVideoListRow, mapVideoDetailRow } from "../../repositories/video-mapping";
import type { Bindings } from "../../types/bindings";
import type { VideoListCriteria, VideoReadRepository, VideoStatusCounts } from "../contracts/video-read-repository";

export const videoTagsJson = sql<string>`(SELECT json_group_array(json_object('id',t.id,'name',t.name,'color',t.color))
  FROM (SELECT t.id,t.name,t.color FROM video_tags vt JOIN tags t ON t.id=vt.tag_id
    WHERE vt.video_id="videos"."id" ORDER BY t.name) t)`;
const visual = sql<string | null>`(SELECT json_object('status',r.status,'total_chunks',r.chunk_count,
  'completed_chunks',(SELECT count(*) FROM video_visual_chunks c WHERE c.run_id=r.run_id AND c.frame_count IS NOT NULL))
  FROM video_visual_runs r WHERE r.video_id="videos"."id" AND r.file_key="videos"."file")`
  .mapWith((value: string | null) => value === null ? null : visualProcessingSchema.parse(JSON.parse(value)));
export const videoListProjection = {
  id: videos.id, file: videos.file, title: videos.title, description: videos.description,
  uploaded_at: videos.uploadedAt, status: videos.status, source_type: videos.sourceType,
  source_url: videos.sourceUrl, youtube_video_id: videos.youtubeVideoId, tags: videoTagsJson.as("tags"), visual_processing: visual.as("visual_processing"),
};
export const videoDetailProjection = { ...videoListProjection, user_id: videos.userId, transcript: videos.transcript, error_message: videos.errorMessage };

function filter(userId: string, criteria: VideoListCriteria) {
  const terms: SQL[] = [eq(videos.userId, userId)];
  const statuses = criteria.statusFilter.split(",").map(value => value.trim()).filter(Boolean);
  if (statuses.length) terms.push(inArray(videos.status, statuses));
  if (criteria.tagIds?.length) terms.push(inArray(videos.id,
    sql`(SELECT ${videoTags.videoId} FROM ${videoTags} WHERE ${inArray(videoTags.tagId, criteria.tagIds)})`));
  return and(...terms)!;
}

export function createD1VideoReadRepository(database: D1Database, env: Bindings): VideoReadRepository {
  const db = createD1Connection(database);
  const ordering: Record<string, SQL> = {
    uploaded_at_desc: desc(videos.uploadedAt), uploaded_at_asc: asc(videos.uploadedAt),
    title_asc: asc(videos.title), title_desc: desc(videos.title),
  };
  return {
    async getDetail(videoId, userId, options = {}) {
      const [row] = await db.select(videoDetailProjection).from(videos).where(and(eq(videos.id, videoId), eq(videos.userId, userId))).limit(1);
      return row ? mapVideoDetailRow(env, row, options) : null;
    },
    async getMetadata(videoId, userId) {
      const [row] = await db.select({ ...videoListProjection, error_message: videos.errorMessage, transcript: videos.transcript })
        .from(videos).where(and(eq(videos.id, videoId), eq(videos.userId, userId))).limit(1);
      if (!row) return null;
      // JS offsets count UTF-16 units; SQLite length() counts code points. Keep
      // the existing offset contract, including supplementary Unicode characters.
      return { ...await mapVideoListRow(env, row, { includeFileUrl: false }),
        error_message: row.error_message || null, transcript_available: row.transcript.length > 0,
        transcript_total_chars: row.transcript.length };
    },
    async listStaleUploads(olderThanHours, limit = 100) {
      const rows = await db.select({ id: videos.id, userId: videos.userId, file: videos.file }).from(videos)
        .where(and(eq(videos.status, "uploading"),
          sql`julianday(COALESCE(${videos.uploadHeartbeatAt},${videos.uploadedAt})) < julianday('now') - (${olderThanHours}/24.0)`))
        .orderBy(asc(videos.uploadedAt)).limit(limit);
      return rows.map(row => ({ id: row.id, userId: row.userId, fileKey: row.file || null }));
    },
    async countByStatus(userId) {
      const rows = await db.select({ status: videos.status, count: sql<number>`count(*)` }).from(videos)
        .where(eq(videos.userId, userId)).groupBy(videos.status);
      const result: VideoStatusCounts = { total: 0, completed: 0, pending: 0, processing: 0, indexing: 0, error: 0, uploading: 0 };
      for (const row of rows) {
        result.total += row.count;
        if (["completed", "pending", "processing", "indexing", "error", "uploading"].includes(row.status)) result[row.status as Exclude<keyof VideoStatusCounts, "total">] += row.count;
      }
      return result;
    },
    async listPage(userId, criteria, limit, offset, options = {}) {
      const where = filter(userId, criteria);
      const orderBy = ordering[criteria.sortKey] ?? desc(videos.uploadedAt);
      const mappedOptions = { includeFileUrl: options.includeFileUrls !== false };
      if (!criteria.keyword) {
        const [counts, rows] = await db.batch([
          db.select({ count: sql<number>`count(*)` }).from(videos).where(where),
          db.select(videoListProjection).from(videos).where(where).orderBy(orderBy, desc(videos.id)).limit(limit).offset(offset),
        ]);
        return { count: counts[0].count, results: await Promise.all(rows.map(row => mapVideoListRow(env, row, mappedOptions))) };
      }
      // SQLite's built-in LIKE/NOCASE only fold ASCII. Filter bounded pages in
      // JS so Japanese text, literal %/_ and Unicode case pairs retain meaning.
      // A maintained Unicode search index can optimize this without changing the contract.
      const needle = criteria.keyword.toLowerCase();
      const rows = [];
      let count = 0;
      for (let start = 0; ; start += 200) {
        const page = await db.select(videoListProjection).from(videos).where(where).orderBy(orderBy, desc(videos.id)).limit(200).offset(start);
        for (const row of page) {
          if (!row.title.toLowerCase().includes(needle) && !row.description.toLowerCase().includes(needle)) continue;
          if (count >= offset && rows.length < limit) rows.push(row);
          count++;
        }
        if (page.length < 200) break;
      }
      return { count, results: await Promise.all(rows.map(row => mapVideoListRow(env, row, mappedOptions))) };
    },
  };
}
