"""Resumable chunk decisions independent of providers, queues and persistence."""
from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Callable, Generic, Protocol, TypeVar

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class PendingDispatchDependencies:
    next_heads: Callable[[int | None], list[int]]
    has_pending: Callable[[], bool]
    send_chunk: Callable[[int], None]
    send_finish: Callable[[], None]


def dispatch_pending(deps: PendingDispatchDependencies, *, after_index: int | None = None) -> None:
    for index in deps.next_heads(after_index):
        deps.send_chunk(index)
    # Check the whole plan, not just the completed chunk's continuation lane.
    # Delivery failure retries this step without repeating saved provider work.
    if not deps.has_pending():
        deps.send_finish()


class ChunkRun(Protocol):
    completed: bool
    chunk_count: int
    chunk_seconds: int
    duration_ms: int
    transcription_language: str | None


Run = TypeVar("Run", bound=ChunkRun)


@dataclass(frozen=True)
class ChunkDependencies(Generic[Run]):
    load: Callable[[int, str], Run | None]
    state: Callable[[Run, int], tuple[bool, bool]]
    transcribe: Callable[[Run, int, float, float], list]
    save: Callable[[Run, int, list], bool]
    dispatch: Callable[[Run, int], None]
    reject_no_audio: Callable[[Run, int, str], None]
    check_audio: Callable[[Run], None]
    record_failure: Callable[[Run, int, str], None]
    no_audio_error: type[Exception]


def execute_chunk(video_id: int, run_id: str, chunk_index: int, deps: ChunkDependencies[Run]) -> None:
    run = deps.load(video_id, run_id)
    if not run or run.completed:
        return
    if not 0 <= chunk_index < run.chunk_count:
        raise ValueError("Invalid transcription chunk index")
    active, completed = deps.state(run, chunk_index)
    if not active:
        return
    try:
        if not completed:
            start = chunk_index * run.chunk_seconds
            duration = min(run.chunk_seconds, run.duration_ms / 1000 - start)
            segments = deps.transcribe(run, chunk_index, start, duration)
            if not deps.save(run, chunk_index, segments):
                return
            logger.info("Transcription checkpoint saved: video=%d chunk=%d/%d", video_id, chunk_index + 1, run.chunk_count)
        deps.dispatch(run, chunk_index)
    except deps.no_audio_error as error:
        try:
            deps.check_audio(run)
        except deps.no_audio_error:
            deps.reject_no_audio(run, chunk_index, str(error))
            logger.info("Stopped transcription without audio: video=%d", video_id)
        else:
            deps.record_failure(run, chunk_index, str(error))
            raise
    except Exception as error:
        try:
            deps.record_failure(run, chunk_index, str(error))
        except Exception:
            logger.exception("Could not record transcription failure: video=%d chunk=%d", video_id, chunk_index)
        raise


class UploadedVideo(Protocol):
    id: int
    file_key: str
    transcript_hash: str


class PlannedRun(ChunkRun, Protocol):
    transcript_hash: str


Video = TypeVar("Video", bound=UploadedVideo)
Plan = TypeVar("Plan", bound=PlannedRun)


@dataclass(frozen=True)
class PlanDependencies(Generic[Video, Plan]):
    queue_available: bool
    check_audio: Callable[[Video], None]
    reject_no_audio: Callable[[Video, str], None]
    load: Callable[[int], Plan | None]
    duration: Callable[[Video], float]
    initialize: Callable[[Video, float], Plan | None]
    dispatch: Callable[[Plan], None]
    no_audio_error: type[Exception]


def start_plan(video: Video, deps: PlanDependencies[Video, Plan]) -> None:
    if not deps.queue_available:
        raise RuntimeError("SQS_QUEUE_URL is required for uploaded transcription jobs")
    try:
        deps.check_audio(video)
    except deps.no_audio_error as error:
        deps.reject_no_audio(video, str(error))
        logger.info("Skipping video without audio: video=%d", video.id)
        return
    existing = deps.load(video.id)
    duration = existing.duration_ms / 1000 if existing and existing.transcript_hash == video.transcript_hash else deps.duration(video)
    run = deps.initialize(video, duration)
    if run:
        logger.info("Transcription plan ready: video=%d chunks=%d", video.id, run.chunk_count)
        deps.dispatch(run)


@dataclass(frozen=True)
class FinalizationDependencies(Generic[Run]):
    # Adapter owns the full atomic commit, including stale-source checks.
    commit: Callable[[Run], str | None]
    handoff: Callable[[Run], None]
    start_visuals: Callable[[Run], None]
    handoff_in_commit: bool
    visuals_enabled: bool


def finish_plan(run: Run, deps: FinalizationDependencies[Run]) -> None:
    status = deps.commit(run)
    if status not in {"indexing", "completed"}:
        return
    if not deps.handoff_in_commit:
        deps.handoff(run)
    if deps.visuals_enabled:
        deps.start_visuals(run)
