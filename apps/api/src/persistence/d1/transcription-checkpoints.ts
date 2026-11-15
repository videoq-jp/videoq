import type { TranscriptionCheckpoints, TranscriptionRun } from "../contracts/transcription-checkpoints";
const CURRENT = "strftime('%Y-%m',u.usage_period_start)=strftime('%Y-%m','now')";
const USED = `CASE WHEN ${CURRENT} THEN u.used_processing_seconds ELSE 0 END`;
const ACTIVE = `r.video_id=v.id AND r.file_key=v.file AND r.transcript_hash=versions.revision
  AND r.completed_at IS NULL AND v.status IN ('pending','processing','error')`;
const JOINS = "video_transcription_runs r JOIN videos v ON v.id=r.video_id JOIN video_index_versions versions ON versions.video_id=v.id";
const PROJECTION = `r.video_id AS videoId,r.run_id AS runId,r.file_key AS fileKey,r.transcript_hash AS sourceRevision,
  r.duration_ms AS durationMs,r.chunk_seconds AS chunkSeconds,r.chunk_count AS chunkCount,
  r.completed_at IS NOT NULL AS completed,v.transcription_language AS transcriptionLanguage`;
const normalize = (row: Omit<TranscriptionRun, "completed"> & { completed: boolean | number } | undefined): TranscriptionRun | null => row ? { ...row, completed: Boolean(row.completed) } : null;

export function createD1TranscriptionCheckpoints(database: D1Database): TranscriptionCheckpoints {
  return {
    async load(videoId, runId) {
      return normalize(await database.prepare(`SELECT ${PROJECTION} FROM ${JOINS} WHERE r.video_id=? AND r.file_key=v.file AND (? IS NULL OR r.run_id=?)`)
        .bind(videoId, runId ?? null, runId ?? null).first<TranscriptionRun>() ?? undefined);
    },
    async initialize(input, durationMs, chunkSeconds) {
      const count = Math.ceil(durationMs / (chunkSeconds * 1000));
      if (!Number.isSafeInteger(durationMs) || durationMs <= 0 || durationMs > 3_000_000_000 ||
        !Number.isSafeInteger(chunkSeconds) || chunkSeconds < 30 || chunkSeconds > 300 || count > 10000) throw new Error("Invalid transcription plan");
      const seconds = Math.ceil(durationMs / 1000);
      const token = crypto.randomUUID();
      const runId = crypto.randomUUID();
      const candidate = "EXISTS(SELECT 1 FROM mutation_receipts WHERE token=?)";
      const fresh = "EXISTS(SELECT 1 FROM mutation_receipts WHERE token=? AND effect_applied=0)";
      const result = await database.batch<TranscriptionRun & { kind: string }>([
        database.prepare(`INSERT INTO mutation_receipts(token,kind,resource_id,effect_applied)
          SELECT ?,'transcription_plan',v.id,EXISTS(SELECT 1 FROM video_transcription_runs r WHERE r.video_id=v.id
            AND r.completed_at IS NULL AND r.file_key=v.file AND r.transcript_hash=versions.revision)
          FROM videos v JOIN users u ON u.id=v.user_id JOIN video_index_versions versions ON versions.video_id=v.id
          WHERE v.id=? AND v.user_id=? AND v.file=? AND versions.revision=? AND v.status IN ('pending','processing','error')
            AND (v.processing_seconds>0 OR (u.is_over_quota IS NOT TRUE AND (${USED})<=9007199254740991-?
              AND (u.processing_limit_minutes IS NULL OR (${USED})<=u.processing_limit_minutes*60-?)))`)
          .bind(token, input.videoId, input.userId, input.fileKey, input.sourceRevision, seconds, seconds),
        database.prepare(`UPDATE users AS u SET used_processing_seconds=(${USED})+?,
          used_ai_answers=CASE WHEN ${CURRENT} THEN used_ai_answers ELSE 0 END,
          usage_period_start=CASE WHEN ${CURRENT} THEN usage_period_start ELSE strftime('%Y-%m-%dT%H:%M:%fZ','now','start of month') END
          WHERE id=(SELECT user_id FROM videos WHERE id=? AND processing_seconds=0) AND ${fresh}`).bind(seconds, input.videoId, token),
        database.prepare(`UPDATE videos SET processing_seconds=? WHERE id=? AND processing_seconds=0 AND ${fresh}`).bind(seconds, input.videoId, token),
        database.prepare(`DELETE FROM video_transcription_runs WHERE video_id=? AND ${fresh}`).bind(input.videoId, token),
        database.prepare(`INSERT INTO video_transcription_runs(video_id,run_id,file_key,transcript_hash,duration_ms,chunk_seconds,chunk_count)
          SELECT ?,?,?,?,?,?,? WHERE ${fresh}`).bind(input.videoId, runId, input.fileKey, input.sourceRevision, durationMs, chunkSeconds, count, token),
        database.prepare(`INSERT INTO video_transcription_chunks(run_id,chunk_index) SELECT ?,value FROM json_each(?) WHERE ${fresh}`)
          .bind(runId, JSON.stringify(Array.from({ length: count }, (_, i) => i)), token),
        database.prepare(`UPDATE videos SET status='processing',error_message='' WHERE id=? AND ${candidate}`).bind(input.videoId, token),
        database.prepare(`SELECT ${PROJECTION} FROM ${JOINS} WHERE r.video_id=? AND ${candidate}`).bind(input.videoId, token),
        database.prepare(`SELECT 'quota' AS kind FROM videos v JOIN video_index_versions versions ON versions.video_id=v.id
          WHERE v.id=? AND v.user_id=? AND v.file=? AND versions.revision=? AND v.status IN ('pending','processing','error')
          AND NOT ${candidate}`).bind(input.videoId, input.userId, input.fileKey, input.sourceRevision, token),
        database.prepare("DELETE FROM mutation_receipts WHERE token=?").bind(token),
      ]);
      return { run: normalize(result[7].results[0]), quotaExceeded: result[8].results.length > 0 };
    },
    async pendingHeads(runId, afterIndex) {
      const rows = await database.prepare(`SELECT min(chunk_index) AS chunk_index FROM video_transcription_chunks
        WHERE run_id=? AND segments IS NULL AND (? IS NULL OR (chunk_index>? AND chunk_index%4=?%4)) GROUP BY chunk_index%4 ORDER BY chunk_index%4`)
        .bind(runId, afterIndex ?? null, afterIndex ?? null, afterIndex ?? null).all<{ chunk_index: number }>();
      return rows.results.map(row => row.chunk_index);
    },
    async chunkState(videoId, runId, index) {
      const row = await database.prepare(`SELECT c.segments IS NOT NULL AS completed FROM ${JOINS} JOIN video_transcription_chunks c ON r.run_id=c.run_id WHERE v.id=? AND r.run_id=? AND c.chunk_index=? AND ${ACTIVE}`)
        .bind(videoId, runId, index).first<{ completed: number }>();
      return { active: Boolean(row), completed: Boolean(row?.completed) };
    },
    async saveChunk(videoId, runId, index, segments) {
      const payload = JSON.stringify(segments);
      if (new TextEncoder().encode(payload).length > 1_000_000 || !segments.every(s => Number.isFinite(s.start) && Number.isFinite(s.end) && s.start>=0 && s.end>=s.start && typeof s.text === "string")) throw new Error("Invalid transcription segments");
      const result = await database.batch<{ active: number }>([
        database.prepare(`UPDATE video_transcription_chunks SET segments=?,fallback_segments='{}',last_error='',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
          WHERE run_id=? AND chunk_index=? AND segments IS NULL AND EXISTS(SELECT 1 FROM ${JOINS} WHERE v.id=? AND r.run_id=? AND ${ACTIVE})`)
          .bind(payload, runId, index, videoId, runId),
        database.prepare(`SELECT 1 AS active FROM ${JOINS} WHERE v.id=? AND r.run_id=? AND ${ACTIVE}
          AND EXISTS(SELECT 1 FROM video_transcription_chunks WHERE run_id=r.run_id AND chunk_index=?)`).bind(videoId, runId, index),
      ]);
      return result[1].results.length > 0;
    },
    async readSegments(videoId, runId, afterIndex) {
      const current = await database.prepare(`SELECT 1 AS active FROM ${JOINS} WHERE v.id=? AND r.run_id=? AND ${ACTIVE}`)
        .bind(videoId, runId).first();
      if (!current) return { active: false, rows: [], done: true };
      const page = (await database.prepare(`SELECT chunk_index AS "index",segments FROM video_transcription_chunks
        WHERE run_id=? AND chunk_index>? ORDER BY chunk_index LIMIT 20`).bind(runId, afterIndex)
        .all<{ index: number; segments: string | null }>()).results;
      const rows = [];
      let bytes = 0;
      for (const row of page) {
        const item = { index: row.index, segments: row.segments === null ? null : JSON.parse(row.segments) as import("../contracts/transcription-checkpoints").TranscriptSegment[] };
        const size = new TextEncoder().encode(JSON.stringify(item)).length;
        if (rows.length && bytes+size>1_050_000) break;
        rows.push(item); bytes+=size;
      }
      return { active: true, rows, done: page.length<20 && rows.length===page.length };
    },
    async rejectNoAudio(input, runId, index) {
      const token = crypto.randomUUID();
      const result = await database.batch([
        database.prepare(`INSERT INTO mutation_receipts(token,kind,resource_id) SELECT ?,'transcription_no_audio',v.id
          FROM videos v JOIN video_index_versions versions ON versions.video_id=v.id
          WHERE v.id=? AND v.user_id=? AND v.file=? AND versions.revision=? AND v.status IN ('pending','processing','error')
          AND (? IS NULL OR EXISTS(SELECT 1 FROM video_transcription_runs r WHERE r.video_id=v.id AND r.run_id=? AND r.completed_at IS NULL))`)
          .bind(token, input.videoId, input.userId, input.fileKey, input.sourceRevision, runId ?? null, runId ?? null),
        database.prepare(`UPDATE video_transcription_chunks SET last_error='NO_AUDIO_STREAM',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
          WHERE run_id=(SELECT run_id FROM video_transcription_runs WHERE video_id=?) AND chunk_index=?
          AND EXISTS(SELECT 1 FROM mutation_receipts WHERE token=?)`).bind(input.videoId, index ?? null, token),
        database.prepare(`UPDATE video_transcription_runs SET completed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
          WHERE video_id=? AND completed_at IS NULL AND EXISTS(SELECT 1 FROM mutation_receipts WHERE token=?)`).bind(input.videoId, token),
        database.prepare(`UPDATE videos SET status='error',error_message='NO_AUDIO_STREAM'
          WHERE id=? AND EXISTS(SELECT 1 FROM mutation_receipts WHERE token=?)`).bind(input.videoId, token),
        database.prepare("SELECT token FROM mutation_receipts WHERE token=?").bind(token),
        database.prepare("DELETE FROM mutation_receipts WHERE token=?").bind(token),
      ]);
      return result[4].results.length>0;
    },
    async recordFailure(videoId, runId, index) {
      await database.batch([
        database.prepare(`UPDATE video_transcription_chunks SET failures=failures+1,last_error='TRANSCRIPTION_CHUNK_FAILED',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
          WHERE run_id=? AND chunk_index=? AND segments IS NULL AND EXISTS(SELECT 1 FROM ${JOINS} WHERE v.id=? AND r.run_id=? AND ${ACTIVE})`)
          .bind(runId, index, videoId, runId),
        database.prepare(`UPDATE videos AS v SET status='error',error_message='TRANSCRIPTION_CHUNK_FAILED'
          WHERE id=? AND EXISTS(SELECT 1 FROM video_transcription_runs r JOIN video_index_versions versions ON versions.video_id=r.video_id
            JOIN video_transcription_chunks c ON c.run_id=r.run_id WHERE r.run_id=? AND c.chunk_index=? AND c.failures>=5 AND c.segments IS NULL AND ${ACTIVE})`)
          .bind(videoId, runId, index),
      ]);
    },
  };
}
