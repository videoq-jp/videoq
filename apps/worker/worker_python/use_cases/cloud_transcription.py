"""Revision-fenced transcription lifecycle; adapters own decoding and providers."""
from __future__ import annotations

from dataclasses import dataclass
from typing import Callable, Generic, TypeVar

from worker_python.use_cases.transcription import (
    ProcessingQuotaExceededError, TranscriptionExecutionFailedError,
)

Source = TypeVar("Source")
Video = TypeVar("Video")


@dataclass(frozen=True)
class CloudTranscriptionDependencies(Generic[Source, Video]):
    load: Callable[[int], Source | None]
    status: Callable[[Source], str | None]
    prepare: Callable[[Source], Video]
    is_uploaded: Callable[[Video], bool]
    start_segmented: Callable[[Video], None]
    begin: Callable[[Video], bool]
    transcribe: Callable[[Video], str]
    finish: Callable[[Video, str | None, str | None], str | None]
    segmented_enabled: bool


def execute_cloud_transcription(video_id: int, deps: CloudTranscriptionDependencies[Source, Video]) -> None:
    source = deps.load(video_id)
    if source is None:
        return
    status = deps.status(source)
    if status in {"indexing", "completed"}:
        # The committed save already owns its indexing outbox.
        return
    if status not in {"pending", "processing", "error"}:
        raise TranscriptionExecutionFailedError("Video is not ready for transcription")
    video = deps.prepare(source)
    if deps.is_uploaded(video) and deps.segmented_enabled:
        deps.start_segmented(video)
        return
    if not deps.begin(video):
        raise TranscriptionExecutionFailedError("Transcription source changed before processing; retry")
    transcript = None
    error_code = None
    try:
        transcript = deps.transcribe(video)
    except ProcessingQuotaExceededError:
        error_code = "PROCESSING_QUOTA_EXCEEDED"
    except Exception:
        error_code = "TRANSCRIPTION_FAILED"
    status = deps.finish(video, transcript, error_code)
    if status == "error" and error_code == "TRANSCRIPTION_FAILED":
        raise TranscriptionExecutionFailedError("Cloud transcription failed; retry")
