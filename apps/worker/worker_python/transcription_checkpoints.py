"""Durable range-transcription checkpoints, fenced by video source and transcript."""

from __future__ import annotations

import math
import os
from uuid import uuid4

from psycopg.types.json import Jsonb

from worker_python.db import db_connection
from worker_python.internal_api import call_internal_api, uses_internal_persistence
from worker_python.video_sql import VideoRow, reserve_processing_seconds

from worker_python.domain.transcription_checkpoints import (
    CHUNK_SECONDS, MAX_VIDEO_DURATION_SECONDS, TRANSCRIPTION_LANES,
    TranscriptionRun, TranscriptionQuotaError, assemble_segments, can_reject_source, can_resume,
    checkpoint_count, run_is_current, source_duration_ms, source_is_current,
    terminal_chunk_failure, validate_chunk_seconds,
)


def _run(row) -> TranscriptionRun | None:
    if not row:
        return None
    return TranscriptionRun(
        video_id=row["video_id"], run_id=str(row["run_id"]), file_key=row["file_key"],
        transcript_hash=row["transcript_hash"], duration_ms=row["duration_ms"],
        chunk_seconds=row["chunk_seconds"], chunk_count=row["chunk_count"],
        completed=row["completed_at"] is not None,
        transcription_language=row.get("transcription_language"),
    )


def _cloud_run(row) -> TranscriptionRun | None:
    if row is None:
        return None
    return TranscriptionRun(video_id=row["videoId"], run_id=row["runId"], file_key=row["fileKey"],
        transcript_hash=row["sourceRevision"], duration_ms=row["durationMs"], chunk_seconds=row["chunkSeconds"],
        chunk_count=row["chunkCount"], completed=row["completed"], transcription_language=row.get("transcriptionLanguage"))


def load_run(video_id: int, run_id: str | None = None) -> TranscriptionRun | None:
    if uses_internal_persistence():
        result = call_internal_api("checkpoints/load", {"videoId": video_id, **({"runId": run_id} if run_id else {})})
        return _cloud_run(result.get("run"))
    with db_connection() as conn:
        return _run(conn.execute("""
            SELECT r.*, v.transcription_language FROM video_transcription_runs r JOIN videos v ON v.id = r.video_id
             WHERE r.video_id = %s AND (%s::uuid IS NULL OR r.run_id = %s::uuid)
               AND r.file_key = v.file
        """, (video_id, run_id, run_id)).fetchone())


def configured_chunk_seconds() -> int:
    try:
        seconds = int(os.environ.get("WHISPER_CHUNK_SECONDS", str(CHUNK_SECONDS)))
    except ValueError as error:
        raise ValueError("WHISPER_CHUNK_SECONDS must be an integer from 30 to 300") from error
    return validate_chunk_seconds(seconds)


def initialize_run(video: VideoRow, duration: float) -> TranscriptionRun | None:
    duration_ms = source_duration_ms(duration, video.file_key, video.transcript_hash)
    chunk_seconds = configured_chunk_seconds()
    count = checkpoint_count(duration_ms, chunk_seconds)
    if uses_internal_persistence():
        result = call_internal_api("checkpoints/initialize", {
            "videoId": video.id, "userId": video.user_id, "fileKey": video.file_key,
            "sourceRevision": video.transcript_hash, "durationMs": duration_ms, "chunkSeconds": chunk_seconds,
        })
        if result.get("quotaExceeded") is True:
            raise TranscriptionQuotaError("Processing quota exceeded")
        return _cloud_run(result.get("run"))
    with db_connection() as conn:
        # Always lock video before run/chunks, also matching deletion/finalization.
        current = conn.execute("""
            SELECT status, file, md5(COALESCE(transcript, '')) AS transcript_hash
              FROM videos WHERE id = %s FOR UPDATE
        """, (video.id,)).fetchone()
        if not current or not source_is_current(
            current["status"], current["file"], current["transcript_hash"], video.file_key, video.transcript_hash,
        ):
            return None
        existing = _run(conn.execute(
            "SELECT * FROM video_transcription_runs WHERE video_id = %s", (video.id,),
        ).fetchone())
        if can_resume(existing, video.file_key, video.transcript_hash):
            conn.execute("UPDATE videos SET status = 'processing', error_message = '' WHERE id = %s", (video.id,))
            return existing
        reservation = reserve_processing_seconds(conn, video.id, math.ceil(duration))
        if not reservation.allowed:
            raise TranscriptionQuotaError("Processing quota exceeded")
        conn.execute("DELETE FROM video_transcription_runs WHERE video_id = %s", (video.id,))
        run_id = str(uuid4())
        row = conn.execute("""
            INSERT INTO video_transcription_runs
                (video_id, run_id, file_key, transcript_hash, duration_ms, chunk_seconds, chunk_count)
            VALUES (%s, %s, %s, %s, %s, %s, %s) RETURNING *
        """, (video.id, run_id, video.file_key, video.transcript_hash, duration_ms, chunk_seconds, count)).fetchone()
        conn.execute("""
            INSERT INTO video_transcription_chunks (run_id, chunk_index)
            SELECT %s::uuid, generate_series(0, %s - 1)
        """, (run_id, count))
        conn.execute("UPDATE videos SET status = 'processing', error_message = '' WHERE id = %s", (video.id,))
        return _run(row)


def pending_heads(run: TranscriptionRun, *, after_index: int | None = None) -> list[int]:
    """At most one unfinished chunk per lane; no unbounded SQS fan-out."""
    if uses_internal_persistence():
        result = call_internal_api("checkpoints/pending", {"runId": run.run_id,
            **({"afterIndex": after_index} if after_index is not None else {})})
        return result["indices"]
    with db_connection() as conn:
        rows = conn.execute("""
            SELECT DISTINCT ON (lane) chunk_index FROM (
                SELECT chunk_index, chunk_index %% %(lanes)s AS lane
                  FROM video_transcription_chunks
                 WHERE run_id = %(run)s AND segments IS NULL
                   AND (%(after)s::int IS NULL OR (
                       chunk_index > %(after)s AND chunk_index %% %(lanes)s = %(after)s %% %(lanes)s
                   ))
            ) pending ORDER BY lane, chunk_index
        """, {"lanes": TRANSCRIPTION_LANES, "run": run.run_id, "after": after_index}).fetchall()
        return [row["chunk_index"] for row in rows]


def _lock_current(conn, run: TranscriptionRun) -> bool:
    row = conn.execute("""
        SELECT v.status, v.file, md5(COALESCE(v.transcript, '')) AS transcript_hash,
               r.run_id, r.completed_at
          FROM videos v JOIN video_transcription_runs r ON r.video_id = v.id
         WHERE v.id = %s FOR UPDATE OF v
    """, (run.video_id,)).fetchone()
    return bool(row and run_is_current(
        run, status=row["status"], file_key=row["file"], transcript_hash=row["transcript_hash"],
        run_id=str(row["run_id"]), completed=row["completed_at"] is not None,
    ))


def reject_no_audio(video_id: int, file_key: str, transcript_hash: str,
                    message: str, *, run_id: str | None = None,
                    chunk_index: int | None = None) -> bool:
    """Fence a terminal media error by source and run, then stop queued lanes."""
    if uses_internal_persistence():
        source = call_internal_api("transcription/source", {"videoId": video_id}).get("source")
        if not source:
            return False
        result = call_internal_api("checkpoints/reject", {
            "videoId": video_id, "userId": source["userId"], "fileKey": file_key,
            "sourceRevision": transcript_hash,
            **({"runId": run_id} if run_id else {}),
            **({"index": chunk_index} if chunk_index is not None else {}),
        })
        return result.get("accepted") is True
    with db_connection() as conn:
        row = conn.execute("""
            SELECT v.status, v.file, md5(COALESCE(v.transcript, '')) AS transcript_hash,
                   r.run_id, r.completed_at
              FROM videos v LEFT JOIN video_transcription_runs r ON r.video_id = v.id
             WHERE v.id = %s FOR UPDATE OF v
        """, (video_id,)).fetchone()
        if not row or not can_reject_source(
            status=row["status"], file_key=row["file"], transcript_hash=row["transcript_hash"],
            expected_file=file_key, expected_hash=transcript_hash,
            run_id=str(row["run_id"]) if row["run_id"] is not None else None,
            expected_run_id=run_id, completed=row["completed_at"] is not None,
        ):
            return False
        if row["run_id"] is not None and row["completed_at"] is None:
            conn.execute("""
                UPDATE video_transcription_runs SET completed_at = now()
                 WHERE video_id = %s AND completed_at IS NULL
            """, (video_id,))
        if chunk_index is not None and row["run_id"] is not None:
            conn.execute("""
                UPDATE video_transcription_chunks SET last_error = %s, updated_at = now()
                 WHERE run_id = %s AND chunk_index = %s
            """, (message, row["run_id"], chunk_index))
        conn.execute("UPDATE videos SET status = 'error', error_message = %s WHERE id = %s",
                     (message, video_id))
        return True


def chunk_state(run: TranscriptionRun, index: int) -> tuple[bool, bool]:
    """(current run still owns video, result already saved)."""
    if uses_internal_persistence():
        result = call_internal_api("checkpoints/state", {"videoId": run.video_id, "runId": run.run_id, "index": index})
        return result["active"], result["completed"]
    with db_connection() as conn:
        if not _lock_current(conn, run):
            return False, False
        row = conn.execute("""
            SELECT segments IS NOT NULL AS completed FROM video_transcription_chunks
             WHERE run_id = %s AND chunk_index = %s
        """, (run.run_id, index)).fetchone()
        if not row:
            raise ValueError("Transcription chunk does not exist")
        return True, row["completed"]


def save_chunk(run: TranscriptionRun, index: int, segments: list[dict]) -> bool:
    if uses_internal_persistence():
        result = call_internal_api("checkpoints/save", {"videoId": run.video_id, "runId": run.run_id, "index": index, "segments": segments})
        return result.get("accepted") is True
    with db_connection() as conn:
        if not _lock_current(conn, run):
            return False
        conn.execute("""
            UPDATE video_transcription_chunks
               SET segments = %s, fallback_segments = '{}'::jsonb,
                   last_error = '', updated_at = now()
             WHERE run_id = %s AND chunk_index = %s AND segments IS NULL
        """, (Jsonb(segments), run.run_id, index))
        return True


def record_chunk_failure(run: TranscriptionRun, index: int, error: str) -> None:
    if uses_internal_persistence():
        call_internal_api("checkpoints/failure", {"videoId": run.video_id, "runId": run.run_id, "index": index})
        return
    with db_connection() as conn:
        if not _lock_current(conn, run):
            return
        row = conn.execute("""
            UPDATE video_transcription_chunks SET failures = failures + 1,
                   last_error = %s, updated_at = now()
             WHERE run_id = %s AND chunk_index = %s AND segments IS NULL RETURNING failures
        """, (error[:2000], run.run_id, index)).fetchone()
        message = terminal_chunk_failure(index, row["failures"], error) if row else None
        if message is not None:
            conn.execute("UPDATE videos SET status = 'error', error_message = %s WHERE id = %s",
                         (message, run.video_id))


def assembled_segments(conn, run: TranscriptionRun) -> list[dict] | None:
    rows = conn.execute("""
        SELECT chunk_index, segments FROM video_transcription_chunks
         WHERE run_id = %s ORDER BY chunk_index
    """, (run.run_id,)).fetchall()
    return assemble_segments(run.chunk_count, [row["segments"] for row in rows])
