"""Shared SQL helpers for video rows."""

from __future__ import annotations

import logging
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from typing import Any

import psycopg

from worker_python.video_status import VideoStatus

logger = logging.getLogger(__name__)


@dataclass
class VideoRow:
    id: int
    user_id: str
    title: str
    transcript: str | None
    status: str
    source_type: str
    file_key: str | None
    youtube_video_id: str | None
    transcript_hash: str | None = None
    transcription_language: str | None = None


@dataclass(frozen=True)
class ProcessingReservationResult:
    allowed: bool
    limit_seconds: int | None = None


def _row_to_video(row: dict[str, Any]) -> VideoRow:
    file_val = row.get("file")
    return VideoRow(
        id=int(row["id"]),
        # users.id is a UUID text PK (migration 0006); int() would raise ValueError.
        user_id=str(row["user_id"]),
        title=row["title"],
        transcript=row.get("transcript") or None,
        status=row["status"],
        source_type=row.get("source_type") or "uploaded",
        file_key=file_val if file_val else None,
        youtube_video_id=row.get("youtube_video_id") or None,
        transcript_hash=row.get("transcript_hash"),
        transcription_language=row.get("transcription_language"),
    )


def get_video_for_task(
    conn: psycopg.Connection[Any], video_id: int, *, include_transcript: bool = True
) -> VideoRow | None:
    # Transcription and its delivery retries only need metadata. Keep the large
    # existing transcript in PostgreSQL unless the caller needs to index it.
    transcript_column = (
        "transcript" if include_transcript
        else "NULL AS transcript, md5(COALESCE(transcript, '')) AS transcript_hash"
    )
    row = conn.execute(
        f"""
        SELECT id, user_id, title, {transcript_column}, status, source_type,
               file, youtube_video_id, transcription_language
          FROM videos
         WHERE id = %s
        """,
        (video_id,),
    ).fetchone()
    return _row_to_video(row) if row else None


def reserve_processing_seconds(
    conn: psycopg.Connection[Any], video_id: int, seconds: int
) -> ProcessingReservationResult:
    """Reserve monthly processing usage once per video under one row lock."""
    if seconds <= 0:
        raise ValueError("processing seconds must be positive")

    video = conn.execute(
        """
        SELECT user_id, processing_seconds
          FROM videos
         WHERE id = %s
         FOR UPDATE
        """,
        (video_id,),
    ).fetchone()
    if video is None:
        raise ValueError(f"Video {video_id} not found")
    if int(video.get("processing_seconds") or 0) > 0:
        return ProcessingReservationResult(allowed=True)

    user_id = str(video["user_id"])
    reserved = conn.execute(
        """
        UPDATE users
           SET used_processing_seconds = CASE
                 WHEN usage_period_start IS NULL
                   OR date_trunc('month', usage_period_start, 'UTC')
                      <> date_trunc('month', now(), 'UTC')
                 THEN %s
                 ELSE used_processing_seconds + %s
               END,
               used_ai_answers = CASE
                 WHEN usage_period_start IS NULL
                   OR date_trunc('month', usage_period_start, 'UTC')
                      <> date_trunc('month', now(), 'UTC')
                 THEN 0
                 ELSE used_ai_answers
               END,
               usage_period_start = CASE
                 WHEN usage_period_start IS NULL
                   OR date_trunc('month', usage_period_start, 'UTC')
                      <> date_trunc('month', now(), 'UTC')
                 THEN now()
                 ELSE usage_period_start
               END
         WHERE id = %s
           AND is_over_quota IS NOT TRUE
           AND (
             processing_limit_minutes IS NULL
             OR CASE
                  WHEN usage_period_start IS NULL
                    OR date_trunc('month', usage_period_start, 'UTC')
                       <> date_trunc('month', now(), 'UTC')
                  THEN 0
                  ELSE used_processing_seconds
                END <= processing_limit_minutes::bigint * 60 - %s
           )
        RETURNING used_processing_seconds
        """,
        (seconds, seconds, user_id, seconds),
    ).fetchone()
    if reserved is None:
        state = conn.execute(
            """
            SELECT processing_limit_minutes
              FROM users
             WHERE id = %s
            """,
            (user_id,),
        ).fetchone()
        limit = None if state is None else state.get("processing_limit_minutes")
        return ProcessingReservationResult(
            allowed=False,
            limit_seconds=None if limit is None else int(limit) * 60,
        )

    conn.execute(
        "UPDATE videos SET processing_seconds = %s WHERE id = %s",
        (seconds, video_id),
    )
    return ProcessingReservationResult(allowed=True)


def transition_video_status(
    conn: psycopg.Connection[Any],
    video_id: int,
    from_status: VideoStatus | str,
    to_status: VideoStatus | str,
    *,
    error_message: str = "",
) -> bool:
    from_val = (
        from_status.value if isinstance(from_status, VideoStatus) else from_status
    )
    to_val = to_status.value if isinstance(to_status, VideoStatus) else to_status
    cur = conn.execute(
        """
        UPDATE videos
           SET status = %s,
               error_message = %s
         WHERE id = %s AND status = %s
        """,
        (to_val, error_message, video_id, from_val),
    )
    return cur.rowcount > 0


def finish_transcription(
    conn: psycopg.Connection[Any],
    video: VideoRow,
    *,
    transcript: str | None,
    error_message: str = "",
) -> str | None:
    """Finish only the current processing attempt; preserve intervening edits.

    API subtitle edits already enqueue their own reindex. A changed transcript
    therefore completes without another automatic indexing job, including a
    deliberate clear. Existing state changes and deletions are left alone.
    """
    if video.transcript_hash is None:
        raise ValueError("Transcription requires the original transcript fingerprint")
    row = conn.execute(
        """
        WITH target AS (
            SELECT id, status, md5(COALESCE(transcript, '')) AS transcript_hash
              FROM videos WHERE id = %(video_id)s FOR UPDATE
        ), saved AS (
            UPDATE videos
               SET transcript = CASE
                     WHEN target.transcript_hash = %(original_hash)s AND %(transcript)s::text IS NOT NULL
                     THEN %(transcript)s ELSE videos.transcript END,
                   status = CASE
                     WHEN target.transcript_hash <> %(original_hash)s THEN 'completed'
                     WHEN %(transcript)s::text IS NULL THEN 'error'
                     ELSE 'indexing' END,
                   error_message = CASE
                     WHEN target.transcript_hash = %(original_hash)s AND %(transcript)s::text IS NULL
                     THEN %(error_message)s ELSE '' END
              FROM target
             WHERE videos.id = target.id AND target.status = 'processing'
            RETURNING videos.status
        )
        SELECT COALESCE(saved.status, target.status) AS status
          FROM target LEFT JOIN saved ON true
        """,
        {
            "video_id": video.id, "original_hash": video.transcript_hash,
            "transcript": transcript, "error_message": error_message,
        },
    ).fetchone()
    return row["status"] if row else None


@contextmanager
def stream_completed_videos_with_transcript(
    conn: psycopg.Connection[Any],
) -> Iterator[Iterator[VideoRow]]:
    """Stream bounded batches of transcripts while the caller owns the cursor."""
    with conn.cursor(name="videoq_reindex_videos") as cursor:
        cursor.itersize = 10
        cursor.execute(
            """
            SELECT id, user_id, title, transcript, status, source_type,
                   file, youtube_video_id
              FROM videos
             WHERE status = %s
               AND transcript IS NOT NULL
               AND transcript <> ''
             ORDER BY id
            """,
            (VideoStatus.COMPLETED.value,),
        )
        yield (_row_to_video(row) for row in cursor)


def delete_video_cascade(
    conn: psycopg.Connection[Any], video_id: int, user_id: str
) -> None:
    """Delete an owned video; foreign keys cascade to tags and membership rows."""
    deleted = conn.execute(
        "DELETE FROM videos WHERE id = %s AND user_id = %s",
        (video_id, user_id),
    ).rowcount
    if deleted:
        logger.info("Deleted video %d (user %s) and related rows", video_id, user_id)
