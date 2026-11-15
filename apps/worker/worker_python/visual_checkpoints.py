"""Durable visual work fenced by source identity and video deletion."""

from dataclasses import dataclass
import math
from uuid import uuid4

from worker_python.db import db_connection
from worker_python.internal_api import call_internal_api, uses_internal_persistence
from worker_python.pipeline.visual_chunks import CHUNK_SECONDS, MAX_DURATION_SECONDS


@dataclass(frozen=True)
class VisualRun:
    video_id: int
    run_id: str
    file_key: str
    duration_ms: int
    chunk_count: int
    status: str


def _run(row):
    return VisualRun(row['video_id'], str(row['run_id']), row['file_key'], row['duration_ms'],
                     row['chunk_count'], row['status']) if row else None


def _cloud_run(row):
    return VisualRun(row["videoId"], row["runId"], row["fileKey"], row["durationMs"], row["chunkCount"], row["status"]) if row else None


def load_run(video_id: int, run_id: str | None = None) -> VisualRun | None:
    if uses_internal_persistence():
        return _cloud_run(call_internal_api("visual/load", {"videoId":video_id, **({"runId":run_id} if run_id else {})}).get("run"))
    with db_connection() as conn:
        return _run(conn.execute("""
            SELECT r.* FROM video_visual_runs r JOIN videos v ON v.id = r.video_id
             WHERE r.video_id = %s AND (%s::uuid IS NULL OR r.run_id = %s::uuid)
               AND r.file_key = v.file AND v.source_type = 'uploaded'
        """, (video_id, run_id, run_id)).fetchone())


def initialize(video_id: int, file_key: str, duration: float) -> VisualRun | None:
    if not math.isfinite(duration) or not 0 < duration <= MAX_DURATION_SECONDS:
        raise ValueError("Visual inspection supports videos up to 10 hours")
    duration_ms = math.ceil(duration * 1000)
    count = math.ceil(duration_ms / (CHUNK_SECONDS * 1000))
    if uses_internal_persistence():
        return _cloud_run(call_internal_api("visual/initialize", {"videoId":video_id,"fileKey":file_key,"durationMs":duration_ms}).get("run"))
    with db_connection() as conn:
        row = conn.execute("SELECT file, source_type FROM videos WHERE id = %s FOR UPDATE", (video_id,)).fetchone()
        if not row or row['file'] != file_key or row['source_type'] != 'uploaded':
            return None
        existing = _run(conn.execute("SELECT * FROM video_visual_runs WHERE video_id = %s", (video_id,)).fetchone())
        if existing and existing.file_key == file_key:
            return existing
        conn.execute("DELETE FROM video_visual_runs WHERE video_id = %s", (video_id,))
        run = _run(conn.execute("""
            INSERT INTO video_visual_runs (video_id, run_id, file_key, duration_ms, chunk_count)
            VALUES (%s, %s, %s, %s, %s) RETURNING *
        """, (video_id, str(uuid4()), file_key, duration_ms, count)).fetchone())
        conn.execute("INSERT INTO video_visual_chunks (run_id, chunk_index) SELECT %s::uuid, generate_series(0, %s - 1)",
                     (run.run_id, count))
        return run


def lock_current(conn, run: VisualRun) -> bool:
    row = conn.execute("""
        SELECT r.run_id, r.file_key, v.file FROM videos v
        JOIN video_visual_runs r ON r.video_id = v.id WHERE v.id = %s FOR UPDATE OF v
    """, (run.video_id,)).fetchone()
    return bool(row and str(row['run_id']) == run.run_id and row['file'] == row['file_key'] == run.file_key)


def pending_chunks(run: VisualRun) -> list[int]:
    if uses_internal_persistence():
        return call_internal_api("visual/pending", {"videoId":run.video_id,"runId":run.run_id})["indices"]
    with db_connection() as conn:
        rows = conn.execute("""
            SELECT chunk_index FROM video_visual_chunks
             WHERE run_id = %s AND frame_count IS NULL ORDER BY chunk_index
        """, (run.run_id,)).fetchall()
        return [row['chunk_index'] for row in rows]


def chunk_complete(run: VisualRun, index: int) -> bool:
    if uses_internal_persistence():
        rows = call_internal_api("visual/chunks", {"videoId":run.video_id,"runId":run.run_id}).get("chunks")
        return bool(rows and any(row["index"]==index and row["frameCount"] is not None for row in rows))
    with db_connection() as conn:
        row = conn.execute("SELECT frame_count FROM video_visual_chunks WHERE run_id = %s AND chunk_index = %s",
                           (run.run_id, index)).fetchone()
        return bool(row and row['frame_count'] is not None)


def record_failure(run: VisualRun, error: str, index: int | None = None) -> None:
    if uses_internal_persistence():
        call_internal_api("visual/failure", {"videoId":run.video_id,"runId":run.run_id,**({"index":index} if index is not None else {})})
        return
    with db_connection() as conn:
        if not lock_current(conn, run):
            return
        if index is not None:
            # A failed delivery after publication must not erase a saved chunk.
            conn.execute("""UPDATE video_visual_chunks SET failures = failures + 1, last_error = %s, updated_at = now()
                            WHERE run_id = %s AND chunk_index = %s AND frame_count IS NULL""",
                         (error[:2000], run.run_id, index))
        conn.execute("UPDATE video_visual_runs SET status = 'error', last_error = %s WHERE run_id = %s AND status <> 'ready'",
                     (error[:2000], run.run_id))
