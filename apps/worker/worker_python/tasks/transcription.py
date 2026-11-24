"""transcribe_video — VideoQ transcription pipeline."""

from __future__ import annotations

import os
import logging
from contextlib import contextmanager

from worker_python.contracts import JOB_INDEX_VIDEO_TRANSCRIPT
from worker_python.db import db_connection
from worker_python.env import heavy_pipeline_enabled
from worker_python.pipeline.transcription import run_transcription
from worker_python.internal_api import uses_internal_persistence
from worker_python.pipeline.user_secret_envelope import try_decrypt
from worker_python.sqs_enqueue import child_job_id, enqueue_job
from worker_python.video_sql import (
    get_video_for_task,
    reserve_processing_seconds,
    finish_transcription,
    transition_video_status,
)
from worker_python.video_status import VideoStatus

from worker_python.use_cases.segmented_transcription_start import QuotaRecovery, start_segmented_transcription
from worker_python.use_cases.transcription_source import require_transcription_source_allowed

logger = logging.getLogger(__name__)


from worker_python.use_cases.transcription import (
    ProcessingQuotaExceededError, TranscriptionExecutionFailedError,
    TranscriptionDependencies, execute_transcription,
)


def _load_searchapi_key(user_id: str) -> str | None:
    from worker_python.env import env_str

    override = env_str("TRANSCRIPTAPI_API_KEY")
    if override:
        return override
    with db_connection() as conn:
        row = conn.execute(
            "SELECT searchapi_api_key_encrypted FROM users WHERE id = %s",
            (user_id,),
        ).fetchone()
    if not row:
        return None
    return try_decrypt(row.get("searchapi_api_key_encrypted"))


def _enqueue_indexing(video_id: int, parent_job_id: str) -> None:
    payload = {"video_id": video_id}
    next_job_id = child_job_id(parent_job_id, JOB_INDEX_VIDEO_TRANSCRIPT, payload)
    message_id = enqueue_job(JOB_INDEX_VIDEO_TRANSCRIPT, payload, job_id=next_job_id)
    if message_id:
        return
    raise RuntimeError("Search queue is unavailable; retry the TypeScript indexing handoff")


def transcribe_video(video_id: int, *, job_id: str | None = None) -> None:
    """Select the runtime adapter and execute the transcription lifecycle."""
    logger.info("Transcription task started for video ID: %d", video_id)
    if uses_internal_persistence():
        from worker_python.tasks.cloud_transcription import transcribe_cloud_video
        transcribe_cloud_video(video_id)
        return

    def load(identifier):
        with db_connection() as conn:
            return get_video_for_task(conn, identifier, include_transcript=False)

    def begin(video):
        with db_connection() as conn:
            return transition_video_status(conn, video.id, video.status, VideoStatus.PROCESSING)

    def finish(video, transcript, error_message):
        with db_connection() as conn:
            return finish_transcription(conn, video, transcript=transcript, error_message=error_message)

    def transcribe(video):
        require_transcription_source_allowed(video.source_type, os.environ.get("DEPLOYMENT_EDITION") != "onprem")
        searchapi_key = _load_searchapi_key(video.user_id) if video.source_type == "youtube" else None

        def reserve_processing(seconds: int) -> None:
            with db_connection() as conn:
                reservation = reserve_processing_seconds(conn, video.id, seconds)
            if not reservation.allowed:
                limit = reservation.limit_seconds
                detail = "unlimited" if limit is None else f"{limit} seconds"
                raise ProcessingQuotaExceededError(f"Processing quota exceeded (limit: {detail})")

        return run_transcription(video, searchapi_key=searchapi_key, reserve_processing=reserve_processing)

    def start_segmented(video):
        from worker_python.tasks.segmented_transcription import start_uploaded_transcription
        @contextmanager
        def recovery():
            # The same connection owns transition and failure save/rollback.
            with db_connection() as conn:
                yield QuotaRecovery(
                    begin=lambda: transition_video_status(conn, video.id, video.status, VideoStatus.PROCESSING),
                    finish=lambda message: finish_transcription(conn, video, transcript=None, error_message=message),
                )

        start_segmented_transcription(lambda: start_uploaded_transcription(video), recovery)

    execute_transcription(video_id, TranscriptionDependencies(
        load=load, begin=begin, transcribe=transcribe, finish=finish,
        handoff=_enqueue_indexing, start_segmented=start_segmented,
        segmented_enabled=heavy_pipeline_enabled(),
    ), job_id=job_id)
