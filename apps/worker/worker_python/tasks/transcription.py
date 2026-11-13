"""transcribe_video — VideoQ transcription pipeline."""

from __future__ import annotations

import os
import logging

from worker_python.contracts import JOB_INDEX_VIDEO_TRANSCRIPT
from worker_python.db import db_connection
from worker_python.env import heavy_pipeline_enabled
from worker_python.pipeline.transcription import run_transcription
from worker_python.internal_api import uses_internal_persistence
from worker_python.pipeline.user_secret_envelope import try_decrypt
from worker_python.sqs_enqueue import child_job_id, enqueue_job
from worker_python.tasks.indexing import index_video_transcript
from worker_python.video_sql import (
    get_video_for_task,
    reserve_processing_seconds,
    finish_transcription,
    transition_video_status,
)
from worker_python.video_status import VideoStatus

logger = logging.getLogger(__name__)


class TranscriptionExecutionFailedError(Exception):
    pass


class ProcessingQuotaExceededError(Exception):
    pass


def _load_searchapi_key(user_id: str) -> str | None:
    from worker_python.env import env_str

    override = env_str("SEARCHAPI_API_KEY")
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


def _enqueue_or_run_indexing(video_id: int, parent_job_id: str) -> None:
    payload = {"video_id": video_id}
    next_job_id = child_job_id(parent_job_id, JOB_INDEX_VIDEO_TRANSCRIPT, payload)
    message_id = enqueue_job(JOB_INDEX_VIDEO_TRANSCRIPT, payload, job_id=next_job_id)
    if message_id:
        return
    logger.info("SQS unavailable; running indexing inline for video %d", video_id)
    index_video_transcript(video_id)


def transcribe_video(video_id: int, *, job_id: str | None = None) -> None:
    """
    Transcribe a video and transition status to INDEXING on success,
    then enqueue (or inline-run) indexing.
    """
    logger.info("Transcription task started for video ID: %d", video_id)

    if uses_internal_persistence():
        from worker_python.tasks.cloud_transcription import transcribe_cloud_video
        transcribe_cloud_video(video_id)
        return

    with db_connection() as conn:
        video = get_video_for_task(conn, video_id, include_transcript=False)

    if video is None:
        logger.info("Video %d was deleted; skipping transcription", video_id)
        return

    parent_job_id = job_id or f"transcribe-video:{video_id}"
    if video.status == VideoStatus.INDEXING.value:
        logger.info("Resuming indexing handoff for video %d", video_id)
        _enqueue_or_run_indexing(video_id, parent_job_id)
        return
    if video.status == VideoStatus.COMPLETED.value:
        logger.info("Skipping duplicate transcription for completed video %d", video_id)
        return
    already_processing = video.status == VideoStatus.PROCESSING.value
    if already_processing:
        logger.info("Resuming interrupted transcription for video %d", video_id)
    elif video.status not in {VideoStatus.PENDING.value, VideoStatus.ERROR.value}:
        raise TranscriptionExecutionFailedError(
            f"Video {video_id} is not ready for transcription (status={video.status})"
        )

    if video.source_type == "uploaded" and heavy_pipeline_enabled():
        from worker_python.tasks.segmented_transcription import start_uploaded_transcription
        from worker_python.transcription_checkpoints import TranscriptionQuotaError
        try:
            start_uploaded_transcription(video)
        except TranscriptionQuotaError as exc:
            with db_connection() as conn:
                if transition_video_status(conn, video.id, video.status, VideoStatus.PROCESSING):
                    finish_transcription(conn, video, transcript=None, error_message=str(exc))
        return

    transcript: str | None = None
    failure: Exception | None = None
    try:
        if not already_processing:
            with db_connection() as conn:
                if not transition_video_status(conn, video_id, video.status, VideoStatus.PROCESSING):
                    raise TranscriptionExecutionFailedError(
                        f"Video {video_id} could not transition "
                        f"{video.status} → {VideoStatus.PROCESSING.value}"
                    )

        logger.info("Transcription started for video %d (%s)", video.id, video.title)
        if video.source_type == "youtube" and os.environ.get("DEPLOYMENT_EDITION") == "onprem":
            raise RuntimeError("YouTube integration is disabled in the on-prem edition")
        searchapi_key = (
            _load_searchapi_key(video.user_id) if video.source_type == "youtube" else None
        )

        def reserve_processing(seconds: int) -> None:
            with db_connection() as conn:
                reservation = reserve_processing_seconds(conn, video_id, seconds)
            if not reservation.allowed:
                limit = reservation.limit_seconds
                detail = "unlimited" if limit is None else f"{limit} seconds"
                raise ProcessingQuotaExceededError(
                    f"Processing quota exceeded (limit: {detail})"
                )

        transcript = run_transcription(
            video,
            searchapi_key=searchapi_key,
            reserve_processing=reserve_processing,
        )

    except ProcessingQuotaExceededError as exc:
        logger.warning("Processing quota exceeded for video %d: %s", video_id, exc)
        failure = exc
    except TranscriptionExecutionFailedError:
        raise
    except Exception as exc:
        logger.error("Transcription failed for video %d: %s", video_id, exc)
        failure = exc

    with db_connection() as conn:
        status = finish_transcription(
            conn, video, transcript=transcript,
            error_message=str(failure) if failure else "",
        )
    if (
        status == VideoStatus.ERROR.value and failure
        and not isinstance(failure, ProcessingQuotaExceededError)
    ):
        raise TranscriptionExecutionFailedError(
            f"Transcription failed for video {video_id}: {failure}"
        ) from failure
    if status != VideoStatus.INDEXING.value:
        logger.info("Transcription handoff skipped for video %d (current status=%s)", video_id, status)
        return

    logger.info("Transcription completed for video %d; enqueue indexing", video_id)
    try:
        _enqueue_or_run_indexing(video_id, parent_job_id)
    except Exception:
        logger.exception(
            "Indexing after transcription failed for video %d (status left INDEXING)",
            video_id,
        )
        raise
