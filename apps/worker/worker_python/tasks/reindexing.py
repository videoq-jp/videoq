"""reindex_all_videos_embeddings — full embedding rebuild."""

from __future__ import annotations

import logging
from collections.abc import Iterable
from itertools import chain

from worker_python.advisory_locks import full_vector_write_lock
from worker_python.pipeline import vector_index
from worker_python.video_sql import VideoRow, stream_completed_videos_with_transcript
from worker_python.db import db_connection
from worker_python.contracts import JOB_REINDEX_ALL_VIDEOS_EMBEDDINGS, JOB_REINDEX_VIDEO_TRANSCRIPT
from worker_python.job_routing import queue_url_for_job
from worker_python.sqs_enqueue import child_job_id, enqueue_job

logger = logging.getLogger(__name__)


class ReindexingIncompleteError(RuntimeError):
    """At least one video failed; retry the SQS job instead of losing the failure."""


def reindex_all_videos_embeddings(
    *, after_id: int = 0, root_job_id: str | None = None, job_id: str | None = None,
) -> None:
    """Regenerate embedding vectors for all completed videos."""
    logger.info("Re-indexing task started")

    if queue_url_for_job(JOB_REINDEX_ALL_VIDEOS_EMBEDDINGS):
        if not job_id:
            raise ValueError("Queued full reindex requires a stable parent job_id")
        _dispatch_page(after_id, root_job_id or job_id)
        return

    with full_vector_write_lock() as lock_conn:
        with stream_completed_videos_with_transcript(lock_conn) as videos:
            _run_reindex(videos)


def _dispatch_page(after_id: int, job_id: str) -> None:
    # Only IDs cross the dispatcher; transcripts and embedding API work belong
    # to individual jobs. Bound both DB reads and SQS sends per invocation.
    page_size = 25
    with db_connection() as conn:
        rows = conn.execute(
            """SELECT id FROM videos
                 WHERE id > %s AND status = 'completed'
                   AND transcript IS NOT NULL AND transcript <> ''
                 ORDER BY id LIMIT %s""",
            (after_id, page_size + 1),
        ).fetchall()

    # Fail this page before publishing any children if every index operation
    # would fail on the same storage contract. Recheck on continuation pages too.
    if rows:
        vector_index.check_embedding_storage()

    def send(kind: str, payload: dict) -> None:
        if not enqueue_job(kind, payload, job_id=child_job_id(job_id, kind, payload)):
            raise RuntimeError("Failed to enqueue full reindex child job")

    for row in rows[:page_size]:
        send(JOB_REINDEX_VIDEO_TRANSCRIPT, {"video_id": row["id"]})
    # Send continuation last. On failure the parent retries with identical IDs;
    # the execution ledger skips children that already completed.
    if len(rows) > page_size:
        send(JOB_REINDEX_ALL_VIDEOS_EMBEDDINGS, {
            "after_id": rows[page_size - 1]["id"], "root_job_id": job_id,
        })
    logger.info("Dispatched reindex page after=%s videos=%s", after_id, min(len(rows), page_size))


def _run_reindex(videos: Iterable[VideoRow]) -> None:
    """Run while the caller holds the global PostgreSQL advisory lock."""

    remaining = iter(videos)
    first = next(remaining, None)
    if first is None:
        logger.info("Re-indexing completed: No videos to re-index")
        return

    vector_index.check_embedding_storage()

    successful_count = 0
    failed_count = 0

    for total, video in enumerate(chain((first,), remaining), start=1):
        try:
            # Keep each video's old scenes until its replacement commits. A
            # provider/write failure must not empty the rest of the search index.
            vector_index.index_video_transcript(video)
            successful_count += 1
            logger.info(
                "[%d] Re-indexed video %d (%s)", total, video.id, video.title
            )
        except Exception:
            logger.exception("Failed to re-index video %d", video.id)
            failed_count += 1

    message = f"Re-indexed {successful_count}/{total} videos"
    if failed_count:
        raise ReindexingIncompleteError(f"{message}; {failed_count} video(s) failed")
    logger.info("Re-indexing completed: %s", message)
