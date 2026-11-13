"""reindex_video_transcript — reindex after manual transcript edit."""

from __future__ import annotations

import logging

from worker_python.advisory_locks import video_vector_write_lock
from worker_python.db import db_connection
from worker_python.internal_api import uses_internal_persistence
from worker_python.pipeline import vector_index
from worker_python.video_sql import get_video_for_task

logger = logging.getLogger(__name__)


def reindex_video_transcript(video_id: int) -> None:
    """Atomically replace this video's index, or remove it for a cleared transcript."""
    logger.info("Reindex transcript task started for video ID: %d", video_id)

    if uses_internal_persistence():
        from worker_python.pipeline.cloud_scene_index import reindex_cloud_video
        reindex_cloud_video(video_id)
        return

    with video_vector_write_lock(video_id):
        with db_connection() as conn:
            video = get_video_for_task(conn, video_id)
        if video is None:
            logger.warning("ReindexVideoTranscript: video %d not found, skipping", video_id)
            return

        if video.transcript and video.transcript.strip():
            vector_index.index_video_transcript(video)
            logger.info("Successfully reindexed transcript for video %d", video_id)
        else:
            vector_index.delete_video_vectors(video_id)
            logger.info(
                "Transcript cleared for video %d; vectors deleted, no reindex", video_id
            )
