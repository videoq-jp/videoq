"""index_video_transcript — VideoQ vector indexing task."""

from __future__ import annotations

import logging

from worker_python.advisory_locks import video_vector_write_lock
from worker_python.db import db_connection
from worker_python.pipeline import vector_index
from worker_python.video_sql import finish_video_indexing, get_video_for_task
from worker_python.video_status import VideoStatus

logger = logging.getLogger(__name__)


class IndexingExecutionFailedError(Exception):
    """Raised when vector indexing fails and retry is allowed."""


def index_video_transcript(video_id: int, allow_empty: bool = False) -> None:
    """Index a video transcript and transition INDEXING → COMPLETED."""
    logger.info("Indexing task started for video ID: %d", video_id)

    with video_vector_write_lock(video_id):
        with db_connection() as conn:
            video = get_video_for_task(conn, video_id)

        if video is None:
            logger.info("Video %d was deleted; skipping indexing", video_id)
            return
        if video.status == VideoStatus.COMPLETED.value:
            logger.info("Video %d is already indexed", video_id)
            return

        if video.status != VideoStatus.INDEXING.value:
            raise IndexingExecutionFailedError(
                f"Video {video_id} is not ready for indexing (status={video.status})"
            )
        try:
            if allow_empty is True and not (video.transcript or '').strip():
                vector_index.clear_video_transcript_index(video)
            else:
                vector_index.index_video_transcript(video)
        except Exception as exc:
            raise IndexingExecutionFailedError(
                f"Vector indexing failed for video {video_id}: {exc}"
            ) from exc

        with db_connection() as conn:
            updated = finish_video_indexing(conn, video)
            if not updated:
                current = get_video_for_task(conn, video_id)
                if current is not None and current.status == VideoStatus.INDEXING.value:
                    raise IndexingExecutionFailedError('Transcript changed before indexing completion; retry')

        if not updated:
            logger.warning(
                "Video %d was not in %s status during indexing completion",
                video_id,
                VideoStatus.INDEXING.value,
            )

    logger.info("Successfully indexed video %d", video_id)
