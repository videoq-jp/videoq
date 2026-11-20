"""Prepare visual evidence for completed uploads without ASR or embeddings."""
import os

from worker_python.db import db_connection
from worker_python.internal_api import call_internal_api, uses_internal_persistence
from worker_python.pipeline.storage import resolve_media_input
from worker_python.pipeline.transcription import _ffprobe_duration
from worker_python.pipeline.visual_chunks import MAX_DURATION_SECONDS
from worker_python import visual_checkpoints
from worker_python.tasks.segmented_visuals import dispatch, build_video_visual_chunk, finish_video_visuals
from worker_python.video_sql import get_video_for_task


from worker_python.use_cases.visual_preparation import (
    VisualPreparationDependencies, execute_visual_preparation,
)


def prepare_visuals(video_id: int, *, dry_run: bool = False) -> dict:
    def load(identifier):
        if uses_internal_persistence():
            source = call_internal_api("transcription/source", {"videoId": identifier}).get("source")
            if source is not None and (not isinstance(source, dict) or source.get("videoId") != identifier):
                raise ValueError("Invalid video source response")
            return (source.get("sourceType"), source.get("fileKey"), source.get("status")) if source else (None, None, None)
        with db_connection() as conn:
            video = get_video_for_task(conn, identifier, include_transcript=False)
        return (video.source_type, video.file_key, video.status) if video else (None, None, None)

    return execute_visual_preparation(video_id, VisualPreparationDependencies(
        load_source=load,
        load_run=visual_checkpoints.load_run,
        duration=lambda key: _ffprobe_duration(resolve_media_input(key)),
        initialize=visual_checkpoints.initialize,
        dispatch=dispatch,
        build=lambda identifier, run_id, index: build_video_visual_chunk(identifier, run_id, index, dispatch_next=False),
        finish=finish_video_visuals,
        queued=bool(os.environ.get("SQS_QUEUE_URL", "").strip()),
        max_duration_seconds=MAX_DURATION_SECONDS,
    ), dry_run=dry_run)
