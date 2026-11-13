import { buildJobMessage } from "../../lib/job-message";
import type { WorkerTranscriptionRepository } from "../contracts/worker-transcription";
import { enqueueCurrentSceneDeletes, enqueueStagedSceneDeletes } from "./scene-index-writer";

export function createD1WorkerTranscriptionRepository(database: D1Database): WorkerTranscriptionRepository {
  return {
    async readSource(videoId) {
      const result = await database.batch<Record<string, unknown>>([
        database.prepare(`INSERT INTO video_index_versions(video_id,revision) SELECT id,? FROM videos WHERE id=?
          ON CONFLICT(video_id) DO NOTHING`).bind(crypto.randomUUID(), videoId),
        database.prepare(`SELECT v.id AS videoId,v.user_id AS userId,v.title,versions.revision AS sourceRevision,v.file AS fileKey,
          v.status,v.source_type AS sourceType,v.youtube_video_id AS youtubeVideoId,v.transcription_language AS transcriptionLanguage,
          CASE WHEN v.source_type='youtube' THEN u.searchapi_api_key_encrypted ELSE NULL END AS searchapiKeyEncrypted
          FROM videos v JOIN users u ON u.id=v.user_id JOIN video_index_versions versions ON versions.video_id=v.id WHERE v.id=?`).bind(videoId),
      ]);
      return result[1].results[0] as Awaited<ReturnType<WorkerTranscriptionRepository["readSource"]>> ?? null;
    },
    async begin(input, expectedStatus) {
      if (!["pending", "error", "processing"].includes(expectedStatus)) throw new Error("Invalid transcription state");
      const result = await database.prepare(`UPDATE videos SET status='processing',error_message=''
        WHERE id=? AND user_id=? AND file=? AND status=?
          AND EXISTS(SELECT 1 FROM video_index_versions WHERE video_id=videos.id AND revision=?) RETURNING id`)
        .bind(input.videoId, input.userId, input.fileKey, expectedStatus, input.sourceRevision).all();
      return result.results.length > 0;
    },
    async finish(input, transcript, errorCode, runId) {
      if (transcript === null && !["TRANSCRIPTION_FAILED", "PROCESSING_QUOTA_EXCEEDED"].includes(errorCode ?? "")) throw new Error("Invalid transcription failure");
      if (transcript !== null && new TextEncoder().encode(transcript).length > 1_800_000) throw new Error("Transcript exceeds D1 row budget");
      const token = crypto.randomUUID();
      const message = buildJobMessage("index_video_transcript", { video_id: input.videoId });
      const result = await database.batch<{ status: string }>([
        database.prepare(`INSERT INTO mutation_receipts(token,kind,resource_id,effect_applied)
          SELECT ?,'transcription_finish',v.id,versions.revision=? FROM videos v
          JOIN video_index_versions versions ON versions.video_id=v.id
          WHERE v.id=? AND v.user_id=? AND v.file=? AND v.status IN ('processing','error')
            AND (? IS NULL OR EXISTS(SELECT 1 FROM video_transcription_runs r WHERE r.video_id=v.id AND r.run_id=?
              AND r.completed_at IS NULL AND r.file_key=v.file AND r.transcript_hash=versions.revision
              AND r.chunk_count=(SELECT count(*) FROM video_transcription_chunks c WHERE c.run_id=r.run_id AND c.segments IS NOT NULL)))
            AND (? IS NOT NULL OR v.status='processing')`)
          .bind(token, input.sourceRevision, input.videoId, input.userId, input.fileKey, runId ?? null, runId ?? null, runId ?? null),
        database.prepare(`UPDATE videos SET
          transcript=CASE WHEN (SELECT effect_applied FROM mutation_receipts WHERE token=?)=1 AND ? IS NOT NULL THEN ? ELSE transcript END,
          status=CASE WHEN (SELECT effect_applied FROM mutation_receipts WHERE token=?)=0 THEN 'completed'
            WHEN ? IS NULL THEN 'error' ELSE 'indexing' END,
          error_message=CASE WHEN (SELECT effect_applied FROM mutation_receipts WHERE token=?)=1 AND ? IS NULL THEN ? ELSE '' END
          WHERE id=? AND EXISTS(SELECT 1 FROM mutation_receipts WHERE token=?)`)
          .bind(token, transcript, transcript, token, transcript, token, transcript, errorCode ?? "", input.videoId, token),
        database.prepare(`INSERT INTO mutation_receipts(token,kind,resource_id)
          SELECT ?,'transcription_saved',resource_id FROM mutation_receipts WHERE token=? AND effect_applied=1 AND ? IS NOT NULL`)
          .bind(token + ":saved", token, transcript),
        database.prepare(`UPDATE video_index_versions SET revision=? WHERE video_id=?
          AND EXISTS(SELECT 1 FROM mutation_receipts WHERE token=?)`).bind(crypto.randomUUID(), input.videoId, token + ":saved"),
        enqueueCurrentSceneDeletes(database, input.videoId, token + ":saved"),
        enqueueStagedSceneDeletes(database, input.videoId, token + ":saved"),
        database.prepare("DELETE FROM scenes WHERE video_id=? AND EXISTS(SELECT 1 FROM mutation_receipts WHERE token=?)").bind(input.videoId, token + ":saved"),
        database.prepare("DELETE FROM scene_staging WHERE run_id IN(SELECT id FROM scene_index_runs WHERE video_id=?) AND EXISTS(SELECT 1 FROM mutation_receipts WHERE token=?)")
          .bind(input.videoId, token + ":saved"),
        database.prepare(`INSERT INTO external_tasks(kind,payload,dedupe_key) SELECT 'sqs_job',?,?
          WHERE EXISTS(SELECT 1 FROM mutation_receipts WHERE token=?)`)
          .bind(JSON.stringify({ message }), `job:${message.job_id}`, token + ":saved"),
        database.prepare("SELECT status FROM videos WHERE id=? AND user_id=? AND file=?").bind(input.videoId, input.userId, input.fileKey),
        database.prepare("UPDATE video_transcription_runs SET completed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE run_id=? AND EXISTS(SELECT 1 FROM mutation_receipts WHERE token=?)")
          .bind(runId ?? null, token),
        database.prepare("DELETE FROM mutation_receipts WHERE token IN (?,?)").bind(token, token + ":saved"),
      ]);
      return result[9].results[0]?.status ?? null;
    },
  };
}
