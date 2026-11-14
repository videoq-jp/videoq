import { and, asc, desc, eq, ilike, inArray, or, sql, type SQL } from "drizzle-orm";
import { withDb, type Db } from "../../db/pool";
import { videos } from "../../db/schema";
import { sqlNumberArray } from "../../db/sql-array";
import { literalContainsPattern } from "../../db/sql-like";
import type { Bindings } from "../../types/bindings";
import { mapVideoListRow, mapVideoDetailRow } from "../../repositories/video-mapping";
import type { VideoDetail, VideoListItem, VideoListCriteria, VideoStatusCounts, StaleUploadingVideo, VideoReadRepository } from "../contracts/video-read-repository";

const ORDER_MAP: Record<string, SQL> = {
  uploaded_at_desc: desc(videos.uploadedAt),
  uploaded_at_asc: asc(videos.uploadedAt),
  title_asc: asc(videos.title),
  title_desc: desc(videos.title),
};

export const videoTagsJson = sql<string>`COALESCE((
  SELECT json_agg(json_build_object('id', t.id, 'name', t.name, 'color', t.color) ORDER BY t.name)
  FROM video_tags vt JOIN tags t ON t.id = vt.tag_id
  WHERE vt.video_id = "videos"."id"
), '[]'::json)::text`.as("tags");

function buildFilterConditions(userId: string, c: VideoListCriteria): SQL {
  const conditions: SQL[] = [eq(videos.userId, userId)];

  if (c.keyword) {
    const pattern = literalContainsPattern(c.keyword);
    conditions.push(
      or(ilike(videos.title, pattern), ilike(videos.description, pattern))!,
    );
  }

  const statuses = c.statusFilter
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (statuses.length === 1) {
    conditions.push(eq(videos.status, statuses[0]));
  } else if (statuses.length > 1) {
    conditions.push(inArray(videos.status, statuses));
  }

  if (c.tagIds && c.tagIds.length > 0) {
    conditions.push(
      inArray(
        videos.id,
        sql`(SELECT vt.video_id FROM video_tags vt WHERE vt.tag_id = ANY(${sqlNumberArray(c.tagIds)}))`,
      ),
    );
  }

  return and(...conditions)!;
}

export const visualProcessing = sql`(SELECT jsonb_build_object('status', r.status, 'total_chunks', r.chunk_count,
  'completed_chunks', (SELECT count(*)::int FROM video_visual_chunks c WHERE c.run_id = r.run_id AND c.frame_count IS NOT NULL))
  FROM video_visual_runs r WHERE r.video_id = ${videos.id} AND r.file_key = ${videos.file})`;

const videoListSelect = {
  id: videos.id,
  file: videos.file,
  title: videos.title,
  description: videos.description,
  uploaded_at: videos.uploadedAt,
  status: videos.status,
  source_type: videos.sourceType,
  source_url: videos.sourceUrl,
  youtube_video_id: videos.youtubeVideoId,
  tags: videoTagsJson,
  visual_processing: visualProcessing,
};

export const videoDetailSelect = {
  id: videos.id,
  user_id: videos.userId,
  file: videos.file,
  title: videos.title,
  description: videos.description,
  uploaded_at: videos.uploadedAt,
  transcript: videos.transcript,
  status: videos.status,
  source_type: videos.sourceType,
  source_url: videos.sourceUrl,
  youtube_video_id: videos.youtubeVideoId,
  error_message: videos.errorMessage,
  tags: videoTagsJson,
  visual_processing: visualProcessing,
};

export async function readVideoDetail(db: Db, videoId: number, userId: string) {
  const [row] = await db.select(videoDetailSelect)
    .from(videos)
    .where(and(eq(videos.id, videoId), eq(videos.userId, userId)))
    .limit(1);
  return row ?? null;
}

export async function getVideoDetail(
  env: Bindings,
  videoId: number,
  userId: string,
  options: { includeFileUrl?: boolean } = {},
): Promise<VideoDetail | null> {
  const row = await withDb(env, (db) => readVideoDetail(db, videoId, userId));
  return row ? mapVideoDetailRow(env, row, options) : null;
}

export async function getVideoMetadata(env: Bindings, videoId: number, userId: string) {
  const row = await withDb(env, async (db) => {
    const [video] = await db.select({
      ...videoListSelect,
      file: sql<null>`NULL`,
      error_message: videos.errorMessage,
      // MCP offsets count UTF-16 code units, as String.length / slice do.
      // Supplementary Unicode characters contribute two units, not one.
      transcript_total_chars: sql<number>`COALESCE(
        char_length(${videos.transcript}) +
        regexp_count(${videos.transcript} COLLATE "C", ${"[\u{10000}-\u{10ffff}]"}), 0
      )`,
    }).from(videos)
      .where(and(eq(videos.id, videoId), eq(videos.userId, userId)))
      .limit(1);
    return video;
  });
  if (!row) return null;
  return {
    ...await mapVideoListRow(env, row, { includeFileUrl: false }),
    error_message: row.error_message || null,
    transcript_available: row.transcript_total_chars > 0,
    transcript_total_chars: row.transcript_total_chars,
  };
}

export async function listStaleUploadingVideos(
  env: Bindings,
  olderThanHours: number,
  limit = 100,
): Promise<StaleUploadingVideo[]> {
  return withDb(env, async (db) => {
    const rows = await db
      .select({
        id: videos.id,
        userId: videos.userId,
        file: videos.file,
      })
      .from(videos)
      .where(
        and(
          eq(videos.status, "uploading"),
          sql`COALESCE(${videos.uploadHeartbeatAt}, ${videos.uploadedAt}) < NOW() - (${olderThanHours}::double precision * INTERVAL '1 hour')`,
        ),
      )
      .orderBy(asc(videos.uploadedAt))
      .limit(limit);
    return rows.map((r) => ({
      id: Number(r.id),
      userId: String(r.userId),
      fileKey: r.file || null,
    }));
  });
}

const EMPTY_STATUS_COUNTS: VideoStatusCounts = {
  total: 0,
  completed: 0,
  pending: 0,
  processing: 0,
  indexing: 0,
  error: 0,
  uploading: 0,
};

const COUNTED_STATUSES = [
  "completed",
  "pending",
  "processing",
  "indexing",
  "error",
  "uploading",
] as const satisfies ReadonlyArray<Exclude<keyof VideoStatusCounts, "total">>;

export async function countVideosByStatus(
  env: Bindings,
  userId: string,
): Promise<VideoStatusCounts> {
  return withDb(env, async (db) => {
    const rows = await db
      .select({
        status: videos.status,
        count: sql<number>`count(*)::int`,
      })
      .from(videos)
      .where(eq(videos.userId, userId))
      .groupBy(videos.status);

    const stats = { ...EMPTY_STATUS_COUNTS };
    for (const row of rows) {
      stats.total += row.count;
      if ((COUNTED_STATUSES as readonly string[]).includes(row.status)) {
        stats[row.status as (typeof COUNTED_STATUSES)[number]] += row.count;
      }
    }
    return stats;
  });
}

export async function listVideosPage(
  env: Bindings,
  userId: string,
  criteria: VideoListCriteria,
  limit: number,
  offset: number,
  options: { includeFileUrls?: boolean } = {},
): Promise<{ count: number; results: VideoListItem[] }> {
  const where = buildFilterConditions(userId, criteria);
  const orderBy = ORDER_MAP[criteria.sortKey] ?? desc(videos.uploadedAt);

  const { rows, count } = await withDb(env, async (db) => {
    const countRows = await db
      .select({ c: sql<number>`count(*)::int` })
      .from(videos)
      .where(where);
    if (offset >= countRows[0].c) return { rows: [], count: countRows[0].c };

    const listRows = await db
      .select(videoListSelect)
      .from(videos)
      .where(where)
      .orderBy(orderBy, desc(videos.id))
      .limit(limit)
      .offset(offset);

    return { rows: listRows, count: countRows[0].c };
  });

  const results: VideoListItem[] = await Promise.all(
    rows.map((r) =>
      mapVideoListRow(env, r, {
        includeFileUrl: options.includeFileUrls !== false,
      }),
    ),
  );

  return { count, results };
}
export function createPostgresVideoReadRepository(env: Bindings): VideoReadRepository {
 return {
  getDetail: (videoId,userId,options) => getVideoDetail(env,videoId,userId,options),
  getMetadata: (videoId,userId) => getVideoMetadata(env,videoId,userId),
  listStaleUploads: (olderThanHours,limit) => listStaleUploadingVideos(env,olderThanHours,limit),
  countByStatus: userId => countVideosByStatus(env,userId),
  listPage: (userId,criteria,limit,offset,options) => listVideosPage(env,userId,criteria,limit,offset,options),
 };
}
