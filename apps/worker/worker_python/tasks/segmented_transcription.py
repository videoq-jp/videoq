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
from worker_python.env import env_flag
from worker_python.pipeline.srt import create_srt_from_whisper_segments
from worker_python.pipeline.storage import resolve_media_input
from worker_python.pipeline.transcription import (
    NoAudioStreamError, _ffprobe_duration, ensure_audio_stream, transcribe_audio_interval,
)
from worker_python.sqs_enqueue import child_job_id, enqueue_job
from worker_python.video_sql import VideoRow, get_video_for_task, finish_transcription

logger = logging.getLogger(__name__)


def _send(run: checkpoints.TranscriptionRun, kind: str, **extra) -> None:
    payload = {"video_id": run.video_id, **extra}
    if kind != JOB_INDEX_VIDEO_TRANSCRIPT:
        payload["run_id"] = run.run_id
    job_id = child_job_id(run.run_id, kind, payload)
    if not enqueue_job(kind, payload, job_id=job_id):
        raise RuntimeError("SQS delivery is required for resumable video processing")


def _dispatch_pending(run: checkpoints.TranscriptionRun, *, after_index: int | None = None) -> None:
    for index in checkpoints.pending_heads(run, after_index=after_index):
        _send(run, JOB_TRANSCRIBE_VIDEO_CHUNK, chunk_index=index)
    # Each lane checks the whole plan: the last completed chunk sends the finalizer.
    # If delivery fails after a checkpoint commit, retrying that chunk gets here
    # without another paid provider call. Stable job IDs absorb duplicate sends.
    if not checkpoints.pending_heads(run):
        _send(run, JOB_FINISH_VIDEO_TRANSCRIPTION)


def start_uploaded_transcription(video: VideoRow) -> None:
    if not os.environ.get("SQS_QUEUE_URL", "").strip():
        raise RuntimeError("SQS_QUEUE_URL is required for uploaded transcription jobs")
    source = resolve_media_input(video.file_key)
    try:
        ensure_audio_stream(source)
    except NoAudioStreamError as error:
        checkpoints.reject_no_audio(video.id, video.file_key, video.transcript_hash, str(error))
        logger.info("Skipping video without audio: video=%d", video.id)
        return
    existing = checkpoints.load_run(video.id)
    if existing and existing.transcript_hash == video.transcript_hash:
        duration = existing.duration_ms / 1000
    else:
        duration = _ffprobe_duration(source)
    run = checkpoints.initialize_run(video, duration)
    if run:
        logger.info("Transcription plan ready: video=%d chunks=%d", run.video_id, run.chunk_count)
        _dispatch_pending(run)


def transcribe_video_chunk(video_id: int, run_id: str, chunk_index: int) -> None:
    run = checkpoints.load_run(video_id, run_id)
    if not run or run.completed:
        return
    if not 0 <= chunk_index < run.chunk_count:
        raise ValueError("Invalid transcription chunk index")
    active, completed = checkpoints.chunk_state(run, chunk_index)
    if not active:
        return
    source = resolve_media_input(run.file_key)
    try:
        if not completed:
            start = chunk_index * run.chunk_seconds
            duration = min(run.chunk_seconds, run.duration_ms / 1000 - start)
            segments = transcribe_audio_interval(source, start, duration, **({"language": run.transcription_language} if run.transcription_language else {}))
            if not checkpoints.save_chunk(run, chunk_index, segments):
                return
            logger.info("Transcription checkpoint saved: video=%d chunk=%d/%d", video_id, chunk_index + 1, run.chunk_count)
        _dispatch_pending(run, after_index=chunk_index)
    except NoAudioStreamError as error:
        try:
            ensure_audio_stream(source)
        except NoAudioStreamError:
            checkpoints.reject_no_audio(video_id, run.file_key, run.transcript_hash,
                                        str(error), run_id=run.run_id, chunk_index=chunk_index)
            logger.info("Stopped transcription without audio: video=%d", video_id)
        else:
            checkpoints.record_chunk_failure(run, chunk_index, str(error))
            raise
    except Exception as error:
        try:
            checkpoints.record_chunk_failure(run, chunk_index, str(error))
        except Exception:
            logger.exception("Could not record transcription failure: video=%d chunk=%d", video_id, chunk_index)
        raise


def finish_video_transcription(video_id: int, run_id: str) -> None:
    run = checkpoints.load_run(video_id, run_id)
    if not run:
        return
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
            conn.execute("UPDATE videos SET status = 'processing' WHERE id = %s", (video_id,))
            video = get_video_for_task(conn, video_id, include_transcript=False)
            status = finish_transcription(conn, video, transcript=transcript if not empty else None,
                                          error_message="Whisper returned an empty transcript" if empty else "")
            # An all-silent plan is terminal too. An explicit user retry can
            # create a fresh plan instead of endlessly joining the same blanks.
            conn.execute("UPDATE video_transcription_runs SET completed_at = now() WHERE run_id = %s", (run_id,))
        else:
            row = conn.execute("SELECT status FROM videos WHERE id = %s", (video_id,)).fetchone()
            status = row["status"] if row else None
    if empty:
        return
    if status not in {"indexing", "completed"}:
        return
    _send(run, JOB_INDEX_VIDEO_TRANSCRIPT)
    if env_flag("VIDEO_VISUAL_ENABLED", True):
        from worker_python.tasks.segmented_visuals import start_visuals
        start_visuals(video_id, run.file_key, run.duration_ms / 1000)


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
