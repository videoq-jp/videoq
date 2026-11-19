"""Prepare visual evidence for completed uploads without ASR or embeddings."""
import math
import os

from worker_python.db import db_connection
from worker_python.internal_api import call_internal_api, uses_internal_persistence
from worker_python.pipeline.storage import resolve_media_input
from worker_python.pipeline.transcription import _ffprobe_duration
from worker_python.pipeline.visual_chunks import MAX_DURATION_SECONDS
from worker_python import visual_checkpoints
from worker_python.tasks.segmented_visuals import dispatch, build_video_visual_chunk, finish_video_visuals
from worker_python.video_sql import get_video_for_task


def prepare_visuals(video_id: int, *, dry_run: bool = False) -> dict:
    if video_id <= 0:
        raise ValueError("A positive video ID is required")
    if uses_internal_persistence():
        source = call_internal_api("transcription/source", {"videoId": video_id}).get("source")
        if source is not None and (not isinstance(source, dict) or source.get("videoId") != video_id):
            raise ValueError("Invalid video source response")
        kind, file_key, status = (source.get("sourceType"), source.get("fileKey"), source.get("status")) if source else (None, None, None)
    else:
        with db_connection() as conn:
            video = get_video_for_task(conn, video_id, include_transcript=False)
        kind, file_key, status = (video.source_type, video.file_key, video.status) if video else (None, None, None)
    if kind != "uploaded" or not isinstance(file_key, str) or not file_key or status != "completed":
        raise ValueError("An existing completed uploaded video is required")
    existing = visual_checkpoints.load_run(video_id)
    if existing and existing.file_key == file_key and existing.status == "ready":
        return {"video_id": video_id, "visual_preparation": "ready", "chunks": existing.chunk_count}
    duration = _ffprobe_duration(resolve_media_input(file_key))
    if not math.isfinite(duration) or not 0 < duration <= MAX_DURATION_SECONDS:
        raise ValueError("Visual inspection supports videos up to 10 hours")
    if dry_run:
        return {"video_id": video_id, "visual_preparation": "dry_run", "chunks": math.ceil(duration / 60)}
    run = visual_checkpoints.initialize(video_id, file_key, duration)
    if not run:
        raise ValueError("Video source changed before preparation")
    if run.status == "ready":
        return {"video_id": video_id, "visual_preparation": "ready", "chunks": run.chunk_count}
    if os.environ.get("SQS_QUEUE_URL", "").strip():
        dispatch(run)
        return {"video_id": video_id, "visual_preparation": "queued", "chunks": run.chunk_count}
    for index in range(run.chunk_count):
        build_video_visual_chunk(video_id, run.run_id, index, dispatch_next=False)
    finish_video_visuals(video_id, run.run_id)
    current = visual_checkpoints.load_run(video_id, run.run_id)
    if not current or current.status != "ready":
        raise RuntimeError("Visual publication did not become ready; retry preparation")
    return {"video_id": video_id, "visual_preparation": "ready", "chunks": run.chunk_count}
