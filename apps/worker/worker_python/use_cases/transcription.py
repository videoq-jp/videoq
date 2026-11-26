"""Transcription lifecycle; adapters own persistence, providers and queue delivery."""
from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Callable, Generic, Protocol, TypeVar

from worker_python.domain.video_processing import transcription_admission, transcription_failure_retry
from worker_python.domain.video_status import VideoStatus

logger = logging.getLogger(__name__)


class TranscriptionExecutionFailedError(Exception):
    pass


class ProcessingQuotaExceededError(Exception):
    pass


class TranscriptionVideo(Protocol):
    id: int
    title: str
    status: str
    source_type: str


Video = TypeVar("Video", bound=TranscriptionVideo)


@dataclass(frozen=True)
class TranscriptionDependencies(Generic[Video]):
    load: Callable[[int], Video | None]
    begin: Callable[[Video], bool]
    transcribe: Callable[[Video], str]
    finish: Callable[[Video, str | None, str], str]
    handoff: Callable[[int, str], None]
    start_segmented: Callable[[Video], None]
    segmented_enabled: bool


def execute_transcription(video_id: int, deps: TranscriptionDependencies[Video], *, job_id: str | None = None) -> None:
    video = deps.load(video_id)
    if video is None:
        logger.info("Video %d was deleted; skipping transcription", video_id)
        return

    parent_job_id = job_id or f"transcribe-video:{video_id}"
    admission = transcription_admission(video.status)
    if admission == 'handoff':
        logger.info("Resuming indexing handoff for video %d", video_id)
        deps.handoff(video_id, parent_job_id)
        return
    if admission == 'completed':
        logger.info("Skipping duplicate transcription for completed video %d", video_id)
        return
    already_processing = video.status == VideoStatus.PROCESSING.value
    if already_processing:
        logger.info("Resuming interrupted transcription for video %d", video_id)
    elif admission == 'invalid':
        raise TranscriptionExecutionFailedError(
            f"Video {video_id} is not ready for transcription (status={video.status})"
        )

    if video.source_type == "uploaded" and deps.segmented_enabled:
        deps.start_segmented(video)
        return

    transcript: str | None = None
    failure: Exception | None = None
    try:
        if not already_processing:
            if not deps.begin(video):
                raise TranscriptionExecutionFailedError(
                    f"Video {video_id} could not transition {video.status} → {VideoStatus.PROCESSING.value}"
                )

        logger.info("Transcription started for video %d (%s)", video.id, video.title)

        transcript = deps.transcribe(video)

    except ProcessingQuotaExceededError as exc:
        logger.warning("Processing quota exceeded for video %d: %s", video_id, exc)
        failure = exc
    except TranscriptionExecutionFailedError:
        raise
    except Exception as exc:
        logger.error("Transcription failed for video %d: %s", video_id, exc)
        failure = exc

    status = deps.finish(video, transcript, str(failure) if failure else "")

    if (
        transcription_failure_retry(status, failure is not None and not isinstance(failure, ProcessingQuotaExceededError))
    ):
        raise TranscriptionExecutionFailedError(
            f"Transcription failed for video {video_id}: {failure}"
        ) from failure
    if status != VideoStatus.INDEXING.value:
        logger.info("Transcription handoff skipped for video %d (current status=%s)", video_id, status)
        return

    logger.info("Transcription completed for video %d; enqueue indexing", video_id)
    try:
        deps.handoff(video_id, parent_job_id)
    except Exception:
        logger.exception(
            "Indexing after transcription failed for video %d (status left INDEXING)",
            video_id,
        )
        raise
