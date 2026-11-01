"""Durable range-transcription checkpoints, fenced by video source and transcript."""

from __future__ import annotations

from dataclasses import dataclass
import math
import os
from uuid import uuid4

from psycopg.types.json import Jsonb

from worker_python.db import db_connection
from worker_python.video_sql import VideoRow, reserve_processing_seconds

CHUNK_SECONDS = 300
MAX_VIDEO_DURATION_SECONDS = 3_000_000
TRANSCRIPTION_LANES = 4


@dataclass(frozen=True)
class TranscriptionRun:
    video_id: int
    run_id: str
    file_key: str
    transcript_hash: str
    duration_ms: int
    chunk_seconds: int
    chunk_count: int
    completed: bool
    transcription_language: str | None = None


class TranscriptionQuotaError(RuntimeError):
    pass


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


def load_run(video_id: int, run_id: str | None = None) -> TranscriptionRun | None:
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
    if not 30 <= seconds <= CHUNK_SECONDS:
        raise ValueError("WHISPER_CHUNK_SECONDS must be an integer from 30 to 300")
    return seconds


def initialize_run(video: VideoRow, duration: float) -> TranscriptionRun | None:
    if not math.isfinite(duration) or not 0 < duration <= MAX_VIDEO_DURATION_SECONDS:
        raise ValueError("Video duration exceeds the supported transcription range")
    if not video.file_key or not video.transcript_hash:
        raise ValueError("Transcription needs a source and transcript fingerprint")
    duration_ms = math.ceil(duration * 1000)
    chunk_seconds = configured_chunk_seconds()
    count = math.ceil(duration_ms / (chunk_seconds * 1000))
    if count > 10000:
        raise ValueError("Transcription plan exceeds the 10,000-checkpoint limit")
    with db_connection() as conn:
        # Always lock video before run/chunks, also matching deletion/finalization.
        current = conn.execute("""
            SELECT status, file, md5(COALESCE(transcript, '')) AS transcript_hash
              FROM videos WHERE id = %s FOR UPDATE
        """, (video.id,)).fetchone()
        if not current or current["status"] not in {"pending", "processing", "error"}:
            return None
        if current["file"] != video.file_key or current["transcript_hash"] != video.transcript_hash:
            return None
        existing = _run(conn.execute(
            "SELECT * FROM video_transcription_runs WHERE video_id = %s", (video.id,),
        ).fetchone())
        if existing and not existing.completed and (existing.file_key, existing.transcript_hash) == (video.file_key, video.transcript_hash):
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
    return bool(row and row["completed_at"] is None and str(row["run_id"]) == run.run_id
                and row["file"] == run.file_key
                and row["transcript_hash"] == run.transcript_hash
                and row["status"] in {"pending", "processing", "error"})


def reject_no_audio(video_id: int, file_key: str, transcript_hash: str,
                    message: str, *, run_id: str | None = None,
                    chunk_index: int | None = None) -> bool:
    """Fence a terminal media error by source and run, then stop queued lanes."""
    with db_connection() as conn:
        row = conn.execute("""
            SELECT v.status, v.file, md5(COALESCE(v.transcript, '')) AS transcript_hash,
                   r.run_id, r.completed_at
              FROM videos v LEFT JOIN video_transcription_runs r ON r.video_id = v.id
             WHERE v.id = %s FOR UPDATE OF v
        """, (video_id,)).fetchone()
        if not row or row["file"] != file_key or row["transcript_hash"] != transcript_hash:
            return False
        if row["status"] not in {"pending", "processing", "error"}:
            return False
        if run_id is not None and (row["run_id"] is None or str(row["run_id"]) != run_id):
            return False
        if run_id is not None and row["completed_at"] is not None:
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
    with db_connection() as conn:
        if not _lock_current(conn, run):
            return
        row = conn.execute("""
            UPDATE video_transcription_chunks SET failures = failures + 1,
                   last_error = %s, updated_at = now()
             WHERE run_id = %s AND chunk_index = %s AND segments IS NULL RETURNING failures
        """, (error[:2000], run.run_id, index)).fetchone()
        if row and row["failures"] >= 5:
            conn.execute("UPDATE videos SET status = 'error', error_message = %s WHERE id = %s",
                         (f"Transcription chunk {index + 1} failed: {error[:1000]}", run.video_id))


def assembled_segments(conn, run: TranscriptionRun) -> list[dict] | None:
    rows = conn.execute("""
        SELECT chunk_index, segments FROM video_transcription_chunks
         WHERE run_id = %s ORDER BY chunk_index
    """, (run.run_id,)).fetchall()
    if len(rows) != run.chunk_count or any(row["segments"] is None for row in rows):
        return None
    return [segment for row in rows for segment in row["segments"]]
