"""index_video_transcript — VideoQ vector indexing task."""

from __future__ import annotations

import logging

from worker_python.advisory_locks import video_vector_write_lock
from worker_python.db import db_connection
from worker_python.internal_api import uses_internal_persistence
from worker_python.pipeline import vector_index
from worker_python.video_sql import finish_video_indexing, get_video_for_task

logger = logging.getLogger(__name__)


from worker_python.use_cases.indexing import (
    IndexingDependencies, IndexingExecutionFailedError, execute_indexing,
)


def index_video_transcript(video_id: int, allow_empty: bool = False) -> None:
    """Index a video transcript and transition INDEXING → COMPLETED."""
    logger.info("Indexing task started for video ID: %d", video_id)

    if uses_internal_persistence():
        from worker_python.pipeline.cloud_scene_index import reindex_cloud_video
        try:
            reindex_cloud_video(video_id, finish_indexing=True, allow_empty=allow_empty is True)
        except Exception as exc:
            raise IndexingExecutionFailedError(f"Cloud indexing failed for video {video_id}") from exc
        return

    def load(identifier):
        with db_connection() as conn:
            return get_video_for_task(conn, identifier)

    def finish(video):
        with db_connection() as conn:
            updated = finish_video_indexing(conn, video)
            current = None if updated else get_video_for_task(conn, video_id)
            return updated, current

    # The lock spans snapshot loading, provider writes and completion.
    with video_vector_write_lock(video_id):
        execute_indexing(video_id, IndexingDependencies(
            load=load,
            index=vector_index.index_video_transcript,
            clear=vector_index.clear_video_transcript_index,
            finish=finish,
        ), allow_empty=allow_empty)
