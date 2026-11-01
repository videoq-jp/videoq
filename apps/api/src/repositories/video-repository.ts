import {
  and,
  asc,
  desc,
  eq,
  ilike,
  inArray,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import {
  videoSourceTypeSchema,
  videoStatusSchema,
  type VideoSourceType,
  type VideoStatus,
} from "@videoq/trpc";
import { visualProcessingSchema, videoTagSchema } from "@videoq/trpc/schema";
import { type Db, withDb } from "../db/pool";
import { sqlNumberArray } from "../db/sql-array";
import { literalContainsPattern } from "../db/sql-like";
import {
  sceneEmbeddings,
  mcpIdempotencyRecords,
  users,
  videos,
} from "../db/schema";
import {
  insertJobTask,
  insertStorageCleanupTask,
} from "./external-task-repository";
import {
  buildJobMessage,
  JOB_REINDEX_VIDEO_TRANSCRIPT,
  JOB_TRANSCRIBE_VIDEO,
} from "../lib/job-message";
import { parseReservedBytesFromFileKey } from "../lib/upload";
import { reserveUploadInTransaction, refundUnconfirmedUpload } from "./quota-repository";
import {
  findIdempotentResource,
  recordIdempotentResource,
  type CreationIdempotency,
} from "./mcp-idempotency-repository";
import { toUtcIso } from "../shared/datetime";
import { resolveFileUrl } from "../integrations/media";
import type { Bindings } from "../types/bindings";

export type VideoListItem = {
  id: number;
  file: string | null;
  title: string;
  description: string;
  uploaded_at: string;
  status: VideoStatus;
  visual_processing?: { status: "processing" | "ready" | "error"; completed_chunks: number; total_chunks: number } | null;
  source_type: VideoSourceType;
  source_url: string | null;
  youtube_video_id: string | null;
  youtube_embed_url: string | null;
  tags: { id: number; name: string; color: string }[];
};

function videoStatus(value: unknown): VideoStatus {
  return videoStatusSchema.parse(value);
}

function videoSourceType(value: unknown): VideoSourceType {
  return videoSourceTypeSchema.parse(value);
}

// VideoSerializer（詳細）: 一覧 + user / transcript / error_message
export type VideoDetail = VideoListItem & {
  user: string;
  transcript: string | null;
  error_message: string | null;
};

export type OutboxedVideoJob = {
  videoId: number;
  taskId: number;
  jobId: string;
};

export type PendingVideoReservation =
  | { ok: true; videoId: number; fileKey: string; reused: boolean }
  | { idempotencyConflict: true }
  | { monthlyUploadExceeded: true; limit: number }
  | { overQuota: true }
  | { exceeded: true; limit: number };

export type VideoListCriteria = {
  keyword: string; // q
  statusFilter: string; // カンマ区切り
  sortKey: string; // ordering
  tagIds: number[] | null;
};

// 許可済みの並び順。マップ外（空を含む）は -uploaded_at。
const ORDER_MAP: Record<string, SQL> = {
  uploaded_at_desc: desc(videos.uploadedAt),
  uploaded_at_asc: asc(videos.uploadedAt),
  title_asc: asc(videos.title),
  title_desc: desc(videos.title),
};

// Correlate with outer videos explicitly — ${videos.id} emits bare "id"
// which is ambiguous once the subquery joins tags (also has id).
export const videoTagsJson = sql<string>`COALESCE((
  SELECT json_agg(json_build_object('id', t.id, 'name', t.name, 'color', t.color) ORDER BY t.name)
  FROM video_tags vt JOIN tags t ON t.id = vt.tag_id
  WHERE vt.video_id = "videos"."id"
), '[]'::json)::text`.as("tags");

/** WHERE 条件を Drizzle 式で組み立てる。 */
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

// 動画一覧の行→オブジェクト変換（一覧・詳細・講座詳細で共有）。
// 行は少なくとも id/file/title/description/uploaded_at(to_char済)/status/source_type/
// source_url/youtube_video_id/tags(::text) を含むこと。
export async function mapVideoListRow(
  env: Bindings,
  r: Record<string, unknown>,
  options: { includeFileUrl?: boolean } = {},
): Promise<VideoListItem> {
  const youtubeId = (r.youtube_video_id as string) || null;
  return {
    id: Number(r.id),
    file:
      options.includeFileUrl === false
        ? null
        : await resolveFileUrl(env, (r.file as string) || null),
    title: r.title as string,
    description: r.description as string,
    uploaded_at: toUtcIso(r.uploaded_at as string),
    status: videoStatus(r.status),
    ...(r.visual_processing !== undefined ? { visual_processing: r.visual_processing ? visualProcessingSchema.parse(r.visual_processing) : null } : {}),
    source_type: videoSourceType(r.source_type),
    source_url: (r.source_url as string) || null,
    youtube_video_id: youtubeId,
    youtube_embed_url: youtubeId
      ? `https://www.youtube.com/embed/${youtubeId}`
      : null,
    tags: videoTagSchema.array().parse(JSON.parse(r.tags as string)),
  };
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

const videoDetailSelect = {
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

async function readVideoDetail(db: Db, videoId: number, userId: string) {
  const [row] = await db.select(videoDetailSelect)
    .from(videos)
    .where(and(eq(videos.id, videoId), eq(videos.userId, userId)))
    .limit(1);
  return row ?? null;
}

export async function mapVideoDetailRow(
  env: Bindings,
  row: NonNullable<Awaited<ReturnType<typeof readVideoDetail>>>,
  options: { includeFileUrl?: boolean } = {},
): Promise<VideoDetail> {
  return {
    ...await mapVideoListRow(env, row, options),
    user: String(row.user_id),
    transcript: row.transcript || null,
    error_message: row.error_message || null,
  };
}

/** VideoDetailView: id + user_id で1件取得（未所有/不在は null）。 */
export async function getVideoDetail(
  env: Bindings,
  videoId: number,
  userId: string,
  options: { includeFileUrl?: boolean } = {},
): Promise<VideoDetail | null> {
  const row = await withDb(env, (db) => readVideoDetail(db, videoId, userId));
  return row ? mapVideoDetailRow(env, row, options) : null;
}

/** Metadata-only reads do not transfer the transcript or resolve a media URL. */
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

/**
 * 動画メタデータを更新する。タイトルのベクトルメタデータ同期と、
 * transcript再indexのoutbox作成と応答データの取得も同じtransactionに含める。
 */
export async function updateVideo(
  env: Bindings,
  videoId: number,
  userId: string,
  fields: { title?: string; description?: string; transcript?: string },
): Promise<
  | { notFound: true }
  | {
      row: NonNullable<Awaited<ReturnType<typeof readVideoDetail>>>;
      reindexTaskId: number | null;
    }
> {
  return withDb(env, async (db) =>
    db.transaction(async (tx) => {
      // Compare under the row lock without transferring a potentially large transcript.
      const [changes] = await tx
        .select({
          title: fields.title === undefined
            ? sql<boolean>`false`
            : sql<boolean>`${videos.title} IS DISTINCT FROM ${fields.title}`,
          description: fields.description === undefined
            ? sql<boolean>`false`
            : sql<boolean>`${videos.description} IS DISTINCT FROM ${fields.description}`,
          transcript: fields.transcript === undefined
            ? sql<boolean>`false`
            : sql<boolean>`COALESCE(${videos.transcript}, '') IS DISTINCT FROM ${fields.transcript}`,
        })
        .from(videos)
        .where(and(eq(videos.id, videoId), eq(videos.userId, userId)))
        .for("update")
        .limit(1);
      if (!changes) return { notFound: true } as const;

      const patch: { title?: string; description?: string; transcript?: string } = {};
      if (changes.title) patch.title = fields.title;
      if (changes.description) patch.description = fields.description;
      if (changes.transcript) patch.transcript = fields.transcript;
      const row = Object.keys(patch).length > 0
        ? (await tx.update(videos).set(patch)
          .where(and(eq(videos.id, videoId), eq(videos.userId, userId)))
          .returning(videoDetailSelect))[0]
        : await readVideoDetail(tx, videoId, userId);
      if (!row) throw new Error("Locked video disappeared.");

      if (changes.title) {
        await tx
          .update(sceneEmbeddings)
          .set({
            langchainMetadata: sql`jsonb_set(
              COALESCE(${sceneEmbeddings.langchainMetadata}::jsonb, '{}'::jsonb),
              '{video_title}',
              to_jsonb(${fields.title!}::text)
            )`,
          })
          .where(eq(sceneEmbeddings.videoId, videoId));
      }
      let reindexTaskId: number | null = null;
      if (changes.transcript) {
        const message = buildJobMessage(JOB_REINDEX_VIDEO_TRANSCRIPT, {
          video_id: videoId,
        });
        const task = await insertJobTask(tx, { message });
        reindexTaskId = task.id;
      }
      return {
        row,
        reindexTaskId,
      } as const;
    }),
  );
}

/**
 * YouTube 動画レコードを作成する。
 * source_type='youtube', status='pending', file=''。作成した id を返す。
 */
export async function createYoutubeVideo(
  env: Bindings,
  userId: string,
  params: { sourceUrl: string; youtubeVideoId: string; title: string; description: string },
  idempotency?: CreationIdempotency,
): Promise<
  | (Omit<OutboxedVideoJob, "taskId"> & {
      taskId: number | null;
      reused: boolean;
    })
  | { idempotencyConflict: true }
> {
  return withDb(env, async (db) =>
    db.transaction(async (tx) => {
      await tx.execute(sql`SELECT 1 FROM users WHERE id = ${userId} FOR UPDATE`);
      const existing = await findIdempotentResource(tx, userId, idempotency);
      if (existing.found) {
        if (existing.conflict) return { idempotencyConflict: true } as const;
        return {
          videoId: existing.resourceId,
          taskId: null,
          jobId: "",
          reused: true,
        } as const;
      }
      const rows = await tx
        .insert(videos)
        .values({
          userId,
          file: "",
          title: params.title,
          description: params.description,
          status: "pending",
          sourceType: "youtube",
          sourceUrl: params.sourceUrl,
          youtubeVideoId: params.youtubeVideoId,
          transcript: "",
          errorMessage: "",
          uploadedAt: sql`CURRENT_TIMESTAMP`,
        })
        .returning({ id: videos.id });
      const videoId = Number(rows[0].id);
      const message = buildJobMessage(JOB_TRANSCRIBE_VIDEO, { video_id: videoId });
      const task = await insertJobTask(tx, { message });
      await recordIdempotentResource(tx, userId, idempotency, videoId);
      return {
        videoId,
        taskId: task.id,
        jobId: message.job_id,
        reused: false,
      };
    }),
  );
}

/** 確定前の状態と保存先を取得（未所有/不在は found:false）。 */
export async function getVideoUploadState(
  env: Bindings,
  videoId: number,
  userId: string,
): Promise<{ found: false } | { found: true; status: string; fileKey: string | null }> {
  return withDb(env, async (db) => {
    const rows = await db
      .select({ status: videos.status, file: videos.file })
      .from(videos)
      .where(and(eq(videos.id, videoId), eq(videos.userId, userId)))
      .limit(1);
    if (rows.length === 0) return { found: false } as const;
    return { found: true, status: rows[0].status, fileKey: rows[0].file || null } as const;
  });
}

/**
 * 所有者・確認済み保存先が一致する uploading 動画だけを pending に進める。
 * 文字起こしジョブの保存も同じtransactionに含め、競合時はfalseを返す。
 */
export async function confirmUploadedVideo(
  env: Bindings,
  videoId: number,
  userId: string,
  fileKey: string,
): Promise<false | OutboxedVideoJob> {
  return withDb(env, async (db) =>
    db.transaction(async (tx) => {
      const rows = await tx
        .update(videos)
        .set({ status: "pending", errorMessage: "" })
        .where(and(
          eq(videos.id, videoId), eq(videos.userId, userId),
          eq(videos.status, "uploading"), eq(videos.file, fileKey),
        ))
        .returning({ id: videos.id });
      if (rows.length === 0) return false;
      const message = buildJobMessage(JOB_TRANSCRIBE_VIDEO, { video_id: videoId });
      const task = await insertJobTask(tx, { message });
      return { videoId, taskId: task.id, jobId: message.job_id };
    }),
  );
}

/** status=uploading のまま放置された動画（FR-Q3 放棄解放用）。 */
export type StaleUploadingVideo = {
  id: number;
  userId: string;
  fileKey: string | null;
};

/**
 * 署名 URL 期限（1h）を超えても uploading のままの行を取得。
 * `olderThanHours` 未満は対象外。バッチ上限で cron 実行時間を抑える。
 */
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

/**
 * アップロード保留の動画レコードを作成する。
 * status='uploading'、source_type は既定 'uploaded'、uploaded_at=CURRENT_TIMESTAMP。
 * 作成した id を返す。
 */
export async function reserveAndCreatePendingVideo(
  env: Bindings,
  userId: string,
  storageBytes: number,
  fileKey: string,
  title: string,
  description: string,
  idempotency?: CreationIdempotency,
  transcriptionLanguage?: string,
): Promise<PendingVideoReservation> {
  return withDb(env, async (db) =>
    db.transaction(async (tx) => {
      const [owner] = await tx
        .select({ id: users.id })
        .from(users)
        .where(eq(users.id, userId))
        .for("update");
      if (!owner) throw new Error("Quota owner not found.");
      const existing = await findIdempotentResource(tx, userId, idempotency);
      if (existing.found) {
        if (existing.conflict) return { idempotencyConflict: true } as const;
        const rows = await tx
          .select({ id: videos.id, file: videos.file })
          .from(videos)
          .where(and(eq(videos.id, existing.resourceId), eq(videos.userId, userId)))
          .limit(1);
        const video = rows[0];
        if (!video) return { idempotencyConflict: true } as const;
        return {
          ok: true as const,
          videoId: Number(video.id),
          fileKey: video.file,
          reused: true,
        };
      }
      const reservation = await reserveUploadInTransaction(
        tx,
        userId,
        storageBytes,
      );
      if (!("ok" in reservation)) return reservation;
      const rows = await tx
        .insert(videos)
        .values({
          userId,
          file: fileKey,
          transcriptionLanguage,
          title,
          description,
          status: "uploading",
          uploadUsagePeriodStart: reservation.periodStart,
          sourceType: "uploaded",
          sourceUrl: "",
          youtubeVideoId: "",
          transcript: "",
          errorMessage: "",
          uploadedAt: sql`CURRENT_TIMESTAMP`,
        })
        .returning({ id: videos.id });
      const videoId = Number(rows[0].id);
      await recordIdempotentResource(tx, userId, idempotency, videoId);
      return {
        ok: true as const,
        videoId,
        fileKey,
        reused: false,
      };
    }),
  );
}

/** 削除前に file_key と存在を取得（file 空文字/NULL は null）。 */
export async function getVideoFileKey(
  env: Bindings,
  videoId: number,
  userId: string,
): Promise<{ found: false } | { found: true; fileKey: string | null }> {
  return withDb(env, async (db) => {
    const rows = await db
      .select({ file: videos.file })
      .from(videos)
      .where(and(eq(videos.id, videoId), eq(videos.userId, userId)))
      .limit(1);
    if (rows.length === 0) return { found: false } as const;
    return { found: true, fileKey: rows[0].file || null };
  });
}

/**
 * 所有権をロック下で確認し、関連行のFK cascadeと配送taskの保存を含めて削除する。
 * FKを持たないベクトルと冪等性レコードは明示的に削除する。
 * expectedStatus 指定時は、ロック取得時にもその状態である場合だけ削除する。
 * expectedFileKey 指定時は、検証・転送した保存先が変わっていれば削除しない。
 */
export async function deleteVideoCascade(
  env: Bindings,
  videoId: number,
  userId: string,
  options: {
    expectedStatus?: string;
    expectedFileKey?: string;
    fallbackStorageBytes?: number | null;
    /** Recheck abandonment under the row lock, after a concurrent part request. */
    inactiveBefore?: Date;
  } = {},
): Promise<
  | { deleted: false; cleanupTaskId: null }
  | { deleted: true; cleanupTaskId: number | null }
> {
  return withDb(env, async (db) => {
    return db.transaction(async (tx) => {
      const locked = await tx
        .select({ status: videos.status, file: videos.file, multipart: videos.multipartUpload,
          heartbeat: videos.uploadHeartbeatAt, uploadPeriod: videos.uploadUsagePeriodStart })
        .from(videos)
        .where(and(eq(videos.id, videoId), eq(videos.userId, userId)))
        .for("update")
        .limit(1);
      if (
        locked.length === 0 ||
        (options.expectedStatus !== undefined &&
          locked[0].status !== options.expectedStatus) ||
        (options.expectedFileKey !== undefined &&
          locked[0].file !== options.expectedFileKey)
        || (options.inactiveBefore !== undefined && locked[0].heartbeat !== null &&
          new Date(locked[0].heartbeat) >= options.inactiveBefore)
      ) {
        return { deleted: false, cleanupTaskId: null } as const;
      }

      const fileKey = locked[0].file || null;
      const cleanupBytes = fileKey
        ? (parseReservedBytesFromFileKey(fileKey) ??
          options.fallbackStorageBytes ??
          null)
        : null;
      const cleanupTaskId = fileKey
        ? await insertStorageCleanupTask(tx, {
            dedupeKey: `storage:video:${videoId}`,
            userId,
            fileKey,
            bytes: cleanupBytes,
            ...(locked[0].multipart ? { multipartUploadId: locked[0].multipart.uploadId } : {}),
          })
        : null;

      // A completed upload consumes its month's allowance even after deletion.
      // Row locking + the delete make abort refunds idempotent. A previous
      // month's reservation cannot subtract from a new month's usage.
      if (locked[0].status === "uploading" && locked[0].uploadPeriod && cleanupBytes) {
        await refundUnconfirmedUpload(tx, userId, cleanupBytes, locked[0].uploadPeriod);
      }

      await tx
        .delete(mcpIdempotencyRecords)
        .where(
          and(
            eq(mcpIdempotencyRecords.userId, userId),
            eq(mcpIdempotencyRecords.resourceId, videoId),
            inArray(mcpIdempotencyRecords.action, [
              "request_video_upload",
              "create_youtube_video",
            ]),
          ),
        );

      // No FK; remove vector rows so orphan embeddings do not linger.
      await tx.execute(sql`DELETE FROM scene_embeddings WHERE video_id = ${videoId}`);

      // FK cascades remove tags and course memberships.
      await tx
        .delete(videos)
        .where(and(eq(videos.id, videoId), eq(videos.userId, userId)));
      return { deleted: true, cleanupTaskId } as const;
    });
  });
}

export type VideoStatusCounts = {
  total: number;
  completed: number;
  pending: number;
  processing: number;
  indexing: number;
  error: number;
  uploading: number;
};

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

/** ユーザー所有動画の status 別件数（ページングしない全件）。 */
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
