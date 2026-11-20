"""Four bounded SQS lanes, durable chunk results, and an idempotent final handoff."""

from __future__ import annotations

import logging
import os

from worker_python import transcription_checkpoints as checkpoints
from worker_python.contracts import (
    JOB_TRANSCRIBE_VIDEO_CHUNK, JOB_FINISH_VIDEO_TRANSCRIPTION,
    JOB_INDEX_VIDEO_TRANSCRIPT,
)
from worker_python.db import db_connection
from worker_python.internal_api import call_internal_api, uses_internal_persistence
from worker_python.env import env_flag
from worker_python.domain.srt import create_srt_from_whisper_segments
from worker_python.pipeline.storage import resolve_media_input
from worker_python.pipeline.transcription import (
    NoAudioStreamError, _ffprobe_duration, ensure_audio_stream, transcribe_audio_interval,
)
from worker_python.sqs_enqueue import child_job_id, enqueue_job
from worker_python.video_sql import VideoRow, get_video_for_task, finish_transcription

from worker_python.use_cases.segmented_transcription import (
    ChunkDependencies, PlanDependencies, FinalizationDependencies,
    PendingDispatchDependencies, dispatch_pending,
    execute_chunk, start_plan, finish_plan,
)

logger = logging.getLogger(__name__)


def _send(run: checkpoints.TranscriptionRun, kind: str, **extra) -> None:
    payload = {"video_id": run.video_id, **extra}
    if kind != JOB_INDEX_VIDEO_TRANSCRIPT:
        payload["run_id"] = run.run_id
    job_id = child_job_id(run.run_id, kind, payload)
    if not enqueue_job(kind, payload, job_id=job_id):
        raise RuntimeError("SQS delivery is required for resumable video processing")


def _dispatch_pending(run: checkpoints.TranscriptionRun, *, after_index: int | None = None) -> None:
    dispatch_pending(PendingDispatchDependencies(
        next_heads=lambda cursor: checkpoints.pending_heads(run, after_index=cursor),
        has_pending=lambda: bool(checkpoints.pending_heads(run)),
        send_chunk=lambda index: _send(run, JOB_TRANSCRIBE_VIDEO_CHUNK, chunk_index=index),
        send_finish=lambda: _send(run, JOB_FINISH_VIDEO_TRANSCRIPTION),
    ), after_index=after_index)


def start_uploaded_transcription(video: VideoRow) -> None:
    sources = {}

    def source(current):
        if current.file_key not in sources:
            sources[current.file_key] = resolve_media_input(current.file_key)
        return sources[current.file_key]

    start_plan(video, PlanDependencies(
        queue_available=bool(os.environ.get("SQS_QUEUE_URL", "").strip()),
        check_audio=lambda current: ensure_audio_stream(source(current)),
        reject_no_audio=lambda current, message: checkpoints.reject_no_audio(
            current.id, current.file_key, current.transcript_hash, message),
        load=checkpoints.load_run,
        duration=lambda current: _ffprobe_duration(source(current)),
        initialize=checkpoints.initialize_run,
        dispatch=_dispatch_pending,
        no_audio_error=NoAudioStreamError,
    ))


def transcribe_video_chunk(video_id: int, run_id: str, chunk_index: int) -> None:
    # Resolve lazily: replaying a saved checkpoint only needs queue delivery.
    sources = {}

    def source(run):
        if run.run_id not in sources:
            sources[run.run_id] = resolve_media_input(run.file_key)
        return sources[run.run_id]

    def transcribe(run, _index, start, duration):
        return transcribe_audio_interval(source(run), start, duration,
            **({"language": run.transcription_language} if run.transcription_language else {}))

    execute_chunk(video_id, run_id, chunk_index, ChunkDependencies(
        load=checkpoints.load_run,
        state=checkpoints.chunk_state,
        transcribe=transcribe,
        save=checkpoints.save_chunk,
        dispatch=lambda run, index: _dispatch_pending(run, after_index=index),
        reject_no_audio=lambda run, index, message: checkpoints.reject_no_audio(
            run.video_id, run.file_key, run.transcript_hash, message,
            run_id=run.run_id, chunk_index=index),
        check_audio=lambda run: ensure_audio_stream(source(run)),
        record_failure=checkpoints.record_chunk_failure,
        no_audio_error=NoAudioStreamError,
    ))


def finish_video_transcription(video_id: int, run_id: str) -> None:
    run = checkpoints.load_run(video_id, run_id)
    if not run:
        return
    if uses_internal_persistence():
        _finish_cloud_run(run)
        return
    _finish_run(run, cloud=False)


def _start_visuals(run: checkpoints.TranscriptionRun) -> None:
    from worker_python.tasks.segmented_visuals import start_visuals
    start_visuals(run.video_id, run.file_key, run.duration_ms / 1000)


def _finish_run(run: checkpoints.TranscriptionRun, *, cloud: bool) -> None:
    finish_plan(run, FinalizationDependencies(
        commit=_commit_cloud_run if cloud else _commit_local_run,
        handoff=lambda current: _send(current, JOB_INDEX_VIDEO_TRANSCRIPT),
        start_visuals=_start_visuals,
        handoff_in_commit=cloud,
        visuals_enabled=env_flag("VIDEO_VISUAL_ENABLED", True),
    ))


def _commit_local_run(run: checkpoints.TranscriptionRun) -> str | None:
    empty = False
    with db_connection() as conn:
        if not run.completed:
            if not checkpoints._lock_current(conn, run):
                return
            segments = checkpoints.assembled_segments(conn, run)
            if segments is None:
                raise RuntimeError("Transcription chunks are still incomplete")
            transcript = create_srt_from_whisper_segments(segments)
            empty = not transcript.strip()
            conn.execute("UPDATE videos SET status = 'processing' WHERE id = %s", (run.video_id,))
            video = get_video_for_task(conn, run.video_id, include_transcript=False)
            status = finish_transcription(conn, video, transcript=transcript if not empty else None,
                                          error_message="Whisper returned an empty transcript" if empty else "")
            # An all-silent plan is terminal too. An explicit user retry can
            # create a fresh plan instead of endlessly joining the same blanks.
            conn.execute("UPDATE video_transcription_runs SET completed_at = now() WHERE run_id = %s", (run.run_id,))
        else:
            row = conn.execute("SELECT status FROM videos WHERE id = %s", (run.video_id,)).fetchone()
            status = row["status"] if row else None
    return None if empty else status


def build_video_visuals(video_id: int, run_id: str, cache_kind: str) -> None:
    """Upgrade old queued whole-video jobs to the durable chunk pipeline."""
    if not env_flag("VIDEO_VISUAL_ENABLED", True):
        return
    run = checkpoints.load_run(video_id, run_id)
    if not run or not run.completed:
        return
    if cache_kind not in {"coarse", "focus"}:
        raise ValueError("Unknown visual cache kind")
    from worker_python.tasks.segmented_visuals import start_visuals
    start_visuals(video_id, run.file_key, run.duration_ms / 1000)


def _finish_cloud_run(run: checkpoints.TranscriptionRun) -> None:
    _finish_run(run, cloud=True)


def _commit_cloud_run(run: checkpoints.TranscriptionRun) -> str | None:
    transcript = None
    if not run.completed:
        segments = []
        after = -1
        while True:
            page = call_internal_api("checkpoints/segments", {"videoId": run.video_id, "runId": run.run_id, "afterIndex": after})
            if page.get("active") is not True:
                return
            rows = page["rows"]
            for row in rows:
                if row["segments"] is None:
                    raise RuntimeError("Transcription chunks are still incomplete")
                if row["index"] != after + 1:
                    raise RuntimeError("Transcription checkpoint sequence is incomplete")
                segments.extend(row["segments"])
                after = row["index"]
            if page.get("done") is True:
                break
            if not rows:
                raise RuntimeError("Transcription checkpoint page did not advance")
        if after + 1 != run.chunk_count:
            raise RuntimeError("Transcription checkpoint count is incomplete")
        transcript = create_srt_from_whisper_segments(segments)
        if not transcript.strip():
            transcript = None
    result = call_internal_api("checkpoints/finish", {"videoId": run.video_id, "runId": run.run_id, "transcript": transcript})
    if result.get("stale") is True:
        return
    if result.get("completed") is not True:
        raise RuntimeError("Transcription finalization is still pending")
    # Indexing handoff is already in the same D1 batch as transcript completion.
    return result.get("status")
