import { QueryBuilder } from "drizzle-orm/sqlite-core";
import {
  videoStatusFilters,
  videoListOrder,
  countVideoStatuses,
  videoKeywordMatcher,
  videoUploadAbandoned,
} from "../../application/video-catalog";
import { videoReadDrizzleLogic } from "../video-read-policy-sql";
import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNotNull,
  sql,
  type SQL,
} from "drizzle-orm";
import { visualProcessingSchema } from "@videoq/trpc/schema";
import { createD1Connection } from "../../db/d1/connection";
import {
  videos,
  videoTags,
  tags,
  videoVisualRuns as visualRuns,
  videoVisualChunks as visualChunks,
} from "../../db/schema/sqlite";
import {
  mapVideoListRow,
  mapVideoDetailRow,
} from "../../repositories/video-mapping";
import type { Bindings } from "../../types/bindings";
import type {
  VideoListCriteria,
  VideoReadRepository,
} from "../contracts/video-read-repository";

const queryBuilder = new QueryBuilder();
const tagRows = queryBuilder
  .select({ id: tags.id, name: tags.name, color: tags.color })
  .from(videoTags)
  .innerJoin(tags, eq(tags.id, videoTags.tagId))
  .where(eq(videoTags.videoId, videos.id))
  .orderBy(tags.name)
  .as("video_tag_rows");
export const videoTagsJson = sql<string>`(${queryBuilder.select({ value: sql`json_group_array(json_object('id',${tagRows.id},'name',${tagRows.name},'color',${tagRows.color}))` }).from(tagRows)})`;
const completed = queryBuilder
  .select({ value: sql`count(*)` })
  .from(visualChunks)
  .where(
    and(
      eq(visualChunks.runId, visualRuns.runId),
      isNotNull(visualChunks.frameCount),
    ),
  );
const visualQuery = queryBuilder
  .select({
    value: sql`json_object('status',${visualRuns.status},'total_chunks',${visualRuns.chunkCount},'completed_chunks',(${completed}))`,
  })
  .from(visualRuns)
  .where(
    and(eq(visualRuns.videoId, videos.id), eq(visualRuns.fileKey, videos.file)),
  );
const visual = sql<string | null>`(${visualQuery})`.mapWith(
  (value: string | null) =>
    value === null ? null : visualProcessingSchema.parse(JSON.parse(value)),
);
export const videoListProjection = {
  id: videos.id,
  file: videos.file,
  title: videos.title,
  description: videos.description,
  uploaded_at: videos.uploadedAt,
  status: videos.status,
  source_type: videos.sourceType,
  source_url: videos.sourceUrl,
  youtube_video_id: videos.youtubeVideoId,
  tags: videoTagsJson.as("tags"),
  visual_processing: visual.as("visual_processing"),
};
export const videoDetailProjection = {
  ...videoListProjection,
  user_id: videos.userId,
  transcript: videos.transcript,
  error_message: videos.errorMessage,
};

function filter(userId: string, criteria: VideoListCriteria) {
  const terms: SQL[] = [eq(videos.userId, userId)];
  const statuses = videoStatusFilters(criteria.statusFilter);
  if (statuses.length) terms.push(inArray(videos.status, statuses));
  if (criteria.tagIds?.length)
    terms.push(
      inArray(
        videos.id,
        queryBuilder
          .select({ id: videoTags.videoId })
          .from(videoTags)
          .where(inArray(videoTags.tagId, criteria.tagIds)),
      ),
    );
  return and(...terms)!;
}

export function createD1VideoReadRepository(
  database: D1Database,
  env: Bindings,
): VideoReadRepository {
  const db = createD1Connection(database);
  return {
    async getDetail(videoId, userId, options = {}) {
      const [row] = await db
        .select(videoDetailProjection)
        .from(videos)
        .where(and(eq(videos.id, videoId), eq(videos.userId, userId)))
        .limit(1);
      return row ? mapVideoDetailRow(env, row, options) : null;
    },
    async getMetadata(videoId, userId) {
      const [row] = await db
        .select({
          ...videoListProjection,
          error_message: videos.errorMessage,
          transcript: videos.transcript,
        })
        .from(videos)
        .where(and(eq(videos.id, videoId), eq(videos.userId, userId)))
        .limit(1);
      if (!row) return null;
      // JS offsets count UTF-16 units; SQLite length() counts code points. Keep
      // the existing offset contract, including supplementary Unicode characters.
      return {
        ...(await mapVideoListRow(env, row, { includeFileUrl: false })),
        error_message: row.error_message || null,
        transcript_available: row.transcript.length > 0,
        transcript_total_chars: row.transcript.length,
      };
    },
    async listStaleUploads(olderThanHours, limit = 100) {
      const rows = await db
        .select({ id: videos.id, userId: videos.userId, file: videos.file })
        .from(videos)
        .where(
          videoUploadAbandoned(
            videos.status,
            sql`julianday(COALESCE(${videos.uploadHeartbeatAt},${videos.uploadedAt})) < julianday('now') - (${olderThanHours}/24.0)`,
            videoReadDrizzleLogic,
          ),
        )
        .orderBy(asc(videos.uploadedAt))
        .limit(limit);
      return rows.map((row) => ({
        id: row.id,
        userId: row.userId,
        fileKey: row.file || null,
      }));
    },
    async countByStatus(userId) {
      const rows = await db
        .select({ status: videos.status, count: sql<number>`count(*)` })
        .from(videos)
        .where(eq(videos.userId, userId))
        .groupBy(videos.status);
      return countVideoStatuses(rows);
    },
    async listPage(userId, criteria, limit, offset, options = {}) {
      const where = filter(userId, criteria);
      const order = videoListOrder(criteria.sortKey);
      const orderBy =
        order.direction === "asc"
          ? asc(videos[order.field])
          : desc(videos[order.field]);
      const mappedOptions = {
        includeFileUrl: options.includeFileUrls !== false,
      };
      if (!criteria.keyword) {
        const [counts, rows] = await db.batch([
          db
            .select({ count: sql<number>`count(*)` })
            .from(videos)
            .where(where),
          db
            .select(videoListProjection)
            .from(videos)
            .where(where)
            .orderBy(orderBy, desc(videos.id))
            .limit(limit)
            .offset(offset),
        ]);
        return {
          count: counts[0].count,
          results: await Promise.all(
            rows.map((row) => mapVideoListRow(env, row, mappedOptions)),
          ),
        };
      }
      // SQLite's built-in LIKE/NOCASE only fold ASCII. Filter bounded pages in
      // JS so Japanese text, literal %/_ and Unicode case pairs retain meaning.
      // A maintained Unicode search index can optimize this without changing the contract.
      const matches = videoKeywordMatcher(criteria.keyword);
      const rows = [];
      let count = 0;
      for (let start = 0; ; start += 200) {
        const page = await db
          .select(videoListProjection)
          .from(videos)
          .where(where)
          .orderBy(orderBy, desc(videos.id))
          .limit(200)
          .offset(start);
        for (const row of page) {
          if (!matches(row)) continue;
          if (count >= offset && rows.length < limit) rows.push(row);
          count++;
        }
        if (page.length < 200) break;
      }
      return {
        count,
        results: await Promise.all(
          rows.map((row) => mapVideoListRow(env, row, mappedOptions)),
        ),
      };
    },
  };
}
