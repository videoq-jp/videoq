import { and, eq, sql } from "drizzle-orm";
import { createD1Connection } from "../../db/d1/connection";
import { videos } from "../../db/schema/sqlite";
import { buildJobMessage, JOB_REINDEX_VIDEO_TRANSCRIPT } from "../../lib/job-message";
import { parseReservedBytesFromFileKey } from "../../lib/upload";
import type { VideoDetailRow } from "../contracts/video-read-repository";
import { validateVideoDeletionOptions, type VideoMutationRepository } from "../contracts/video-mutation-repository";
import { videoDetailProjection } from "./video-read-repository";
import { enqueueCurrentSceneDeletes, enqueueStagedSceneDeletes } from "./scene-index-writer";

export function createD1VideoMutationRepository(database: D1Database, onIndexWork?: () => Promise<void>, deletionFence?: {sql:string;params:unknown[]}): VideoMutationRepository {
  const db = createD1Connection(database);
  const notify = async () => {
    try { await onIndexWork?.(); } catch { /* Durable work is recovered by scheduled maintenance. */ }
  };
  return {
    async update(videoId, userId, fields) {
      const token = crypto.randomUUID();
      const message = buildJobMessage(JOB_REINDEX_VIDEO_TRANSCRIPT, { video_id: videoId });
      const dedupeKey = `job:${message.job_id}`;
      const read = db.select(videoDetailProjection).from(videos).where(and(eq(videos.id, videoId), eq(videos.userId, userId),
        sql`EXISTS(SELECT 1 FROM mutation_receipts WHERE token=${token})`)).toSQL();
      const results = await database.batch<Record<string, unknown>>([
        database.prepare(`INSERT INTO mutation_receipts(token,kind,resource_id,effect_applied)
          SELECT ?,'video_update',id,? IS NOT NULL AND coalesce(transcript,'') IS NOT ? FROM videos WHERE id=? AND user_id=?`)
          .bind(token, fields.transcript ?? null, fields.transcript ?? null, videoId, userId),
        database.prepare(`UPDATE videos SET title=coalesce(?,title),description=coalesce(?,description),transcript=coalesce(?,transcript)
          WHERE id=? AND EXISTS(SELECT 1 FROM mutation_receipts WHERE token=?)`)
          .bind(fields.title ?? null, fields.description ?? null, fields.transcript ?? null, videoId, token),
        // A second receipt exists only for transcript changes, so metadata-only
        // edits cannot invalidate vectors or enqueue duplicate indexing work.
        database.prepare(`INSERT INTO mutation_receipts(token,kind,resource_id)
          SELECT ?,'video_transcript_update',resource_id FROM mutation_receipts WHERE token=? AND effect_applied=1`)
          .bind(token + ":transcript", token),
        database.prepare(`INSERT INTO video_index_versions(video_id,revision)
          SELECT ?,? WHERE EXISTS(SELECT 1 FROM mutation_receipts WHERE token=?)
          ON CONFLICT(video_id) DO UPDATE SET revision=excluded.revision`).bind(videoId, crypto.randomUUID(), token + ":transcript"),
        enqueueCurrentSceneDeletes(database, videoId, token + ":transcript"),
        enqueueStagedSceneDeletes(database, videoId, token + ":transcript"),
        database.prepare("DELETE FROM scenes WHERE video_id=? AND EXISTS(SELECT 1 FROM mutation_receipts WHERE token=?)").bind(videoId, token + ":transcript"),
        database.prepare("DELETE FROM scene_staging WHERE run_id IN(SELECT id FROM scene_index_runs WHERE video_id=?) AND EXISTS(SELECT 1 FROM mutation_receipts WHERE token=?)")
          .bind(videoId, token + ":transcript"),
        database.prepare(`INSERT INTO external_tasks(kind,payload,dedupe_key) SELECT 'sqs_job',?,?
          WHERE EXISTS(SELECT 1 FROM mutation_receipts WHERE token=?)`).bind(JSON.stringify({ message }), dedupeKey, token + ":transcript"),
        database.prepare(read.sql).bind(...read.params),
        database.prepare("SELECT id FROM external_tasks WHERE dedupe_key=?").bind(dedupeKey),
        database.prepare("DELETE FROM mutation_receipts WHERE token IN (?,?)").bind(token, token + ":transcript"),
      ]);
      const raw = results[9].results[0];
      if (!raw) return { notFound: true };
      const row = raw as VideoDetailRow;
      if (typeof row.visual_processing === "string") row.visual_processing = JSON.parse(row.visual_processing);
      const reindexTaskId = results[10].results[0] ? Number(results[10].results[0].id) : null;
      if (reindexTaskId !== null) await notify();
      return { row, reindexTaskId };
    },
    async delete(videoId, userId, options = {}) {
      validateVideoDeletionOptions(options);
      // External storage size discovery happens before this operation. Capture
      // the small state and fence it in the batch; retry if a concurrent update
      // changed the deletion-sensitive fields before our batch began.
      for (let attempt = 0; attempt < 5; attempt++) {
        const [video] = await db.select({ status: videos.status, file: videos.file, multipart: videos.multipartUpload,
          heartbeat: videos.uploadHeartbeatAt, uploadPeriod: videos.uploadUsagePeriodStart }).from(videos)
          .where(and(eq(videos.id, videoId), eq(videos.userId, userId))).limit(1);
        if (!video || options.expectedStatus !== undefined && video.status !== options.expectedStatus ||
            options.expectedFileKey !== undefined && video.file !== options.expectedFileKey ||
            options.inactiveBefore && video.heartbeat !== null && new Date(video.heartbeat) >= options.inactiveBefore) {
          return { deleted: false, cleanupTaskId: null };
        }
        const token = crypto.randomUUID();
        const fileKey = video.file || null;
        const bytes = fileKey ? parseReservedBytesFromFileKey(fileKey) ?? options.fallbackStorageBytes ?? null : null;
        const cleanupKey = `storage:video:${videoId}`;
        const cleanupPayload = JSON.stringify({ user_id: userId, file_key: fileKey, bytes,
          ...(video.multipart ? { multipart_upload_id: video.multipart.uploadId } : {}) });
        const results = await database.batch<Record<string, unknown>>([
          database.prepare(`INSERT INTO mutation_receipts(token,kind,resource_id)
            SELECT ?,'video_delete',id FROM videos WHERE id=? AND user_id=? AND status=? AND file=?
              AND json(multipart_upload) IS json(?) AND upload_heartbeat_at IS ? AND upload_usage_period_start IS ? AND (${deletionFence?.sql??"1"})`)
            .bind(token, videoId, userId, video.status, video.file, video.multipart ? JSON.stringify(video.multipart) : null, video.heartbeat, video.uploadPeriod,...(deletionFence?.params??[])),
          database.prepare(`INSERT INTO external_tasks(kind,payload,dedupe_key)
            SELECT 'storage_cleanup',?,? WHERE ? IS NOT NULL AND EXISTS(SELECT 1 FROM mutation_receipts WHERE token=?)
            ON CONFLICT(dedupe_key) DO NOTHING`).bind(cleanupPayload, cleanupKey, fileKey, token),
          enqueueCurrentSceneDeletes(database, videoId, token),
          enqueueStagedSceneDeletes(database, videoId, token),
          database.prepare(`UPDATE users SET used_upload_bytes=max(0,used_upload_bytes-?) WHERE id=? AND upload_usage_period_start=?
            AND ?='uploading' AND ?>0 AND EXISTS(SELECT 1 FROM mutation_receipts WHERE token=?)`)
            .bind(bytes ?? 0, userId, video.uploadPeriod, video.status, bytes ?? 0, token),
          database.prepare(`DELETE FROM mcp_idempotency_records WHERE user_id=? AND resource_id=? AND action IN ('request_video_upload','create_youtube_video')
            AND EXISTS(SELECT 1 FROM mutation_receipts WHERE token=?)`).bind(userId, videoId, token),
          database.prepare("DELETE FROM videos WHERE id=? AND user_id=? AND EXISTS(SELECT 1 FROM mutation_receipts WHERE token=?) RETURNING id")
            .bind(videoId, userId, token),
          database.prepare("SELECT id FROM external_tasks WHERE dedupe_key=? AND ? IS NOT NULL").bind(cleanupKey, fileKey),
          database.prepare("DELETE FROM mutation_receipts WHERE token=?").bind(token),
        ]);
        if (results[6].results.length) {
          await notify();
          return { deleted: true, cleanupTaskId: results[7].results[0] ? Number(results[7].results[0].id) : null };
        }
      }
      throw new Error("Video changed repeatedly during deletion; retry the operation");
    },
  };
}
