import { and, eq } from "drizzle-orm";
import { createD1Connection } from "../../db/d1/connection";
import { videos } from "../../db/schema/sqlite";
import { buildJobMessage, JOB_TRANSCRIBE_VIDEO } from "../../lib/job-message";
import type { CreationIdempotency } from "../contracts/creation-idempotency";
import type { VideoUploadRepository } from "../contracts/video-upload-repository";

const GIB = 1024 ** 3;
const CURRENT_MONTH = "strftime('%Y-%m-%dT%H:%M:%fZ','now','start of month')";
const CURRENT_UPLOAD_BYTES = `CASE WHEN strftime('%Y-%m',upload_usage_period_start)=strftime('%Y-%m','now') THEN used_upload_bytes ELSE 0 END`;

function receipt(input: CreationIdempotency | undefined, action: CreationIdempotency["action"]) {
  if (input && (input.action !== action || !input.key || input.key.length > 128 || !/^[a-f0-9]{64}$/.test(input.requestHash))) {
    throw new Error("Invalid creation idempotency");
  }
  return input ?? { action, key: `internal:${crypto.randomUUID()}`, requestHash: "0".repeat(64) };
}

/** Atomic D1 batches implement each business operation; no interactive transactions. */
export function createD1VideoUploadRepository(database: D1Database): VideoUploadRepository {
  const db = createD1Connection(database);
  const rememberCreatedVideo = (userId: string, identity: CreationIdempotency) => database.prepare(`
    INSERT INTO mcp_idempotency_records (user_id,action,key,request_hash,resource_id)
    SELECT ?,?,?,?,last_insert_rowid() WHERE changes()=1
  `).bind(userId, identity.action, identity.key, identity.requestHash);
  const readCreatedVideo = (userId: string, identity: CreationIdempotency) => database.prepare(`
    SELECT i.request_hash,i.resource_id,v.id AS video_id,v.file
    FROM mcp_idempotency_records i LEFT JOIN videos v ON v.id=i.resource_id AND v.user_id=i.user_id
    WHERE i.user_id=? AND i.action=? AND i.key=?
  `).bind(userId, identity.action, identity.key);
  const forgetInternalReceipt = (userId: string, identity: CreationIdempotency, retain: boolean) => database.prepare(`
    DELETE FROM mcp_idempotency_records WHERE user_id=? AND action=? AND key=? AND ?=0
  `).bind(userId, identity.action, identity.key, retain ? 1 : 0);

  return {
    async reserveUpload(p) {
      if (!Number.isSafeInteger(p.storageBytes) || p.storageBytes <= 0) throw new Error("Upload reservation bytes must be a positive safe integer.");
      const identity = receipt(p.idempotency, "request_video_upload");
      const result = await database.batch<Record<string, unknown>>([
        database.prepare(`INSERT INTO videos
          (user_id,file,title,description,transcription_language,status,upload_usage_period_start,
           source_type,source_url,youtube_video_id,transcript,error_message,uploaded_at)
          SELECT id,?,?,?,?, 'uploading',${CURRENT_MONTH},'uploaded','','','','',strftime('%Y-%m-%dT%H:%M:%fZ','now')
          FROM users WHERE id=? AND is_over_quota IS NOT TRUE
            AND (storage_limit_gb IS NULL OR used_storage_bytes <= floor(storage_limit_gb*1073741824)-?)
            AND (monthly_upload_limit_gb IS NULL OR (${CURRENT_UPLOAD_BYTES}) <= floor(monthly_upload_limit_gb*1073741824)-?)
            AND used_storage_bytes <= 9007199254740991-? AND (${CURRENT_UPLOAD_BYTES}) <= 9007199254740991-?
            AND NOT EXISTS (SELECT 1 FROM mcp_idempotency_records WHERE user_id=? AND action=? AND key=?)
        `).bind(p.fileKey, p.title, p.description, p.transcriptionLanguage ?? null, p.userId, p.storageBytes, p.storageBytes,
          p.storageBytes, p.storageBytes, p.userId, identity.action, identity.key),
        rememberCreatedVideo(p.userId, identity),
        // changes() refers to the immediately preceding receipt INSERT in this
        // same atomic batch. Replays must never debit quota a second time.
        database.prepare(`UPDATE users SET used_storage_bytes=used_storage_bytes+?,
          used_upload_bytes=(${CURRENT_UPLOAD_BYTES})+?,upload_usage_period_start=${CURRENT_MONTH}
          WHERE id=? AND changes()=1`).bind(p.storageBytes, p.storageBytes, p.userId),
        readCreatedVideo(p.userId, identity),
        database.prepare(`SELECT is_over_quota,storage_limit_gb,used_storage_bytes,monthly_upload_limit_gb
          FROM users WHERE id=?`).bind(p.userId),
        forgetInternalReceipt(p.userId, identity, Boolean(p.idempotency)),
      ]);
      const row = result[3].results[0];
      if (row) {
        if (row.request_hash !== identity.requestHash || row.video_id === null) return { idempotencyConflict: true };
        return { ok: true, videoId: Number(row.video_id), fileKey: String(row.file), reused: result[0].meta.changes === 0 };
      }
      const state = result[4].results[0];
      if (!state) throw new Error("Quota owner not found.");
      if (state.is_over_quota) return { overQuota: true };
      if (state.storage_limit_gb !== null && Number(state.used_storage_bytes) > Math.floor(Number(state.storage_limit_gb) * GIB) - p.storageBytes) {
        return { exceeded: true, limit: Math.floor(Number(state.storage_limit_gb) * GIB) };
      }
      if (state.monthly_upload_limit_gb !== null) return { monthlyUploadExceeded: true, limit: Math.floor(Number(state.monthly_upload_limit_gb) * GIB) };
      throw new Error("Upload quota exceeds the safe integer range.");
    },
    async createYoutube(p) {
      const identity = receipt(p.idempotency, "create_youtube_video");
      const message = buildJobMessage(JOB_TRANSCRIBE_VIDEO, { video_id: 0 });
      const dedupeKey = `job:${message.job_id}`;
      const result = await database.batch<Record<string, unknown>>([
        database.prepare(`INSERT INTO videos
          (user_id,file,title,description,status,source_type,source_url,youtube_video_id,transcript,error_message,uploaded_at)
          SELECT id,'',?,?,'pending','youtube',?,?,'','',strftime('%Y-%m-%dT%H:%M:%fZ','now')
          FROM users WHERE id=? AND NOT EXISTS
            (SELECT 1 FROM mcp_idempotency_records WHERE user_id=? AND action=? AND key=?)
        `).bind(p.title, p.description, p.sourceUrl, p.youtubeVideoId, p.userId, p.userId, identity.action, identity.key),
        rememberCreatedVideo(p.userId, identity),
        database.prepare(`INSERT INTO external_tasks (kind,payload,dedupe_key)
          SELECT 'sqs_job',json_set(?,'$.message.payload.video_id',resource_id),?
          FROM mcp_idempotency_records WHERE user_id=? AND action=? AND key=? AND changes()=1
        `).bind(JSON.stringify({ message }), dedupeKey, p.userId, identity.action, identity.key),
        readCreatedVideo(p.userId, identity),
        database.prepare("SELECT id FROM external_tasks WHERE dedupe_key=?").bind(dedupeKey),
        forgetInternalReceipt(p.userId, identity, Boolean(p.idempotency)),
      ]);
      const row = result[3].results[0];
      if (!row) throw new Error("Video owner not found.");
      if (row.request_hash !== identity.requestHash) return { idempotencyConflict: true };
      const task = result[4].results[0];
      return { videoId: Number(row.resource_id), taskId: task ? Number(task.id) : null,
        jobId: task ? message.job_id : "", reused: result[0].meta.changes === 0 };
    },
    async confirmUpload({ videoId, userId, fileKey }) {
      const message = buildJobMessage(JOB_TRANSCRIBE_VIDEO, { video_id: videoId });
      const dedupeKey = `job:${message.job_id}`;
      const result = await database.batch<Record<string, unknown>>([
        database.prepare(`INSERT INTO external_tasks (kind,payload,dedupe_key)
          SELECT 'sqs_job',?,? FROM videos WHERE id=? AND user_id=? AND status='uploading' AND file=?
        `).bind(JSON.stringify({ message }), dedupeKey, videoId, userId, fileKey),
        database.prepare(`UPDATE videos SET status='pending',error_message=''
          WHERE id=? AND user_id=? AND status='uploading' AND file=? AND changes()=1
        `).bind(videoId, userId, fileKey),
        database.prepare("SELECT id FROM external_tasks WHERE dedupe_key=?").bind(dedupeKey),
      ]);
      const task = result[2].results[0];
      return task ? { videoId, taskId: Number(task.id), jobId: message.job_id } : false;
    },
    async getUploadState(videoId, userId) {
      const [row] = await db.select({ status: videos.status, file: videos.file }).from(videos)
        .where(and(eq(videos.id, videoId), eq(videos.userId, userId))).limit(1);
      return row ? { found: true, status: row.status, fileKey: row.file || null } : { found: false };
    },
  };
}
