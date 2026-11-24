"""Uploaded (FFmpeg + Whisper) and YouTube (TranscriptAPI) transcription."""

from __future__ import annotations

import json
import os
import logging
import math
import tempfile
from collections.abc import Callable, Generator
from contextlib import closing
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

from .ai_connection import shared_api_key, OPENROUTER_BASE_URL
from worker_python.env import env_flag, env_str, heavy_pipeline_enabled
from worker_python.domain.srt import format_srt_time
from worker_python.domain.transcription_segments import segments_within_interval
from worker_python.pipeline.storage import ObjectMediaSource, resolve_media_input
from worker_python.pipeline.media_process import MEDIA_INPUT_OPTIONS, media_input_args, run_media_process
from worker_python.use_cases.transcription_source import (
    TranscriptionMedia, TranscriptionSourceDependencies, transcribe_source,
)
from worker_python.use_cases.uploaded_transcription import (
    UploadedTranscriptionDependencies, execute_uploaded_transcription,
)

logger = logging.getLogger(__name__)


class NoAudioStreamError(RuntimeError):
    """The source has no audio track, so retrying transcription cannot help."""


NO_AUDIO_MESSAGE = "動画に音声トラックがありません。音声付きの動画をアップロードしてください。"


def run_transcription(
    video: TranscriptionMedia,
    *,
    searchapi_key: str | None = None,
    reserve_processing: Callable[[int], None] | None = None,
) -> str:
    """
    Produce SRT preserving source cue timestamps. Search scenes are built at indexing.

    When ENABLE_HEAVY_PIPELINE is off, returns a placeholder SRT so status
    transitions can be tested without FFmpeg/Whisper (no Otsu).
    """
    def placeholder():
        logger.info("ENABLE_HEAVY_PIPELINE off; placeholder transcript for video %d", video.id)
        return (
            "1\n"
            "00:00:00,000 --> 00:00:01,000\n"
            "[placeholder transcript — enable ENABLE_HEAVY_PIPELINE for real transcription]\n"
        )

    return transcribe_source(video, TranscriptionSourceDependencies(
        youtube=lambda identifier: _transcribe_youtube(identifier, searchapi_key),
        uploaded=lambda source: _transcribe_uploaded(source.file_key, reserve_processing,
            video_id=source.id, language=source.transcription_language),
        placeholder=placeholder, reserve=reserve_processing, real_enabled=heavy_pipeline_enabled(),
        youtube_allowed=os.environ.get("DEPLOYMENT_EDITION") != "onprem",
    ))


def _transcribe_uploaded(
    file_key: str,
    reserve_processing: Callable[[int], None] | None = None,
    *, video_id: int | None = None, language: str | None = None,
) -> str:
    with tempfile.TemporaryDirectory(prefix="videoq-tx-") as tmp:
        tmp_dir = Path(tmp)
        video_path = resolve_media_input(file_key)
        audio_path = tmp_dir / "audio.mp3"

        def optional_visuals():
            if video_id is None or not env_flag("VIDEO_VISUAL_ENABLED", True):
                return ()
            from worker_python.pipeline.visual_frames import build_frame_cache, publish_frame_cache
            from worker_python.pipeline.focus_frames import build_focus_cache, publish_focus_cache

            def frames(duration):
                payload = build_frame_cache(video_path, video_id, duration)
                publish_frame_cache(video_id, file_key, payload)

            def focus(duration):
                with build_focus_cache(video_path, video_id, duration) as pack:
                    publish_focus_cache(video_id, file_key, pack)

            return (("Frame", frames), ("Focus", focus))

        return execute_uploaded_transcription(UploadedTranscriptionDependencies(
            duration=lambda: _ffprobe_duration(video_path), reserve=reserve_processing,
            extract_audio=lambda: _ffmpeg_extract_mp3(video_path, audio_path),
            recognize=lambda: _whisper_transcribe(audio_path, **({"language": language} if language else {})),
            optional_visuals=optional_visuals,
            report_visual_failure=lambda name, error: logger.warning(
                "%s cache unavailable for video %d (%s)", name, video_id, error,
            ),
        ))


def _ffmpeg_extract_mp3(video_path: Path | ObjectMediaSource, audio_path: Path) -> None:
    cmd = [
        "ffmpeg",
        "-nostdin",
        "-xerror",
        "-abort_on", "empty_output",
        "-v", "error",
        "-y",
        *media_input_args(video_path),
        "-vn",
        "-acodec",
        "mp3",
        "-ab",
        "64k",
        "-ar",
        "16000",
        "-ac",
        "1",
        str(audio_path),
    ]
    logger.info("Extracting audio with ffmpeg")
    proc = run_media_process(cmd)
    _check_extracted_audio(proc, audio_path)


def _check_extracted_audio(proc, audio_path: Path) -> None:
    # Matroska can report truncated input but return success, even with -xerror.
    # A recovered HTTP read also logs "Stream ends prematurely"; that transport
    # message alone is not fatal. The demuxer's EOF error is unrecoverable.
    if proc.returncode != 0:
        if "Stream map '" in proc.stderr and "matches no streams" in proc.stderr:
            raise NoAudioStreamError(NO_AUDIO_MESSAGE)
        raise RuntimeError(
            f"ffmpeg failed ({proc.returncode}): {proc.stderr[-1000:]}"
        )
    if "File ended prematurely" in proc.stderr:
        raise RuntimeError(f"ffmpeg failed: incomplete media input: {proc.stderr[-1000:]}")
    if not audio_path.is_file() or audio_path.stat().st_size == 0:
        raise RuntimeError("ffmpeg produced empty audio")


def transcribe_audio_interval(
    source: Path | ObjectMediaSource, start_seconds: float, duration_seconds: float,
    *, language: str | None = None,
) -> list[dict[str, Any]]:
    """A bounded input range and one recognition call; timestamps stay source-relative."""
    max_duration = 300
    if not math.isfinite(start_seconds) or start_seconds < 0 or not 0 < duration_seconds <= max_duration:
        raise ValueError("Invalid transcription interval")
    with tempfile.TemporaryDirectory(prefix="videoq-chunk-") as tmp:
        audio = Path(tmp) / "audio.mp3"
        result = run_media_process([
            "ffmpeg", "-nostdin", "-xerror", "-abort_on", "empty_output", "-v", "error", "-y",
            "-ss", str(start_seconds), *media_input_args(source), "-t", str(duration_seconds),
            "-map", "0:a:0", "-vn", "-af", "aresample=async=1:first_pts=0",
            "-acodec", "mp3", "-ab", "64k", "-ar", "16000", "-ac", "1", str(audio),
        ], max_output_bytes=16 * 1024 * 1024, timeout_seconds=300)
        _check_extracted_audio(result, audio)
        if env_str("WHISPER_BACKEND") == "workers-ai":
            segments = _workers_ai_transcribe(audio, language=language)
            segments = [{**segment, "start": segment["start"] + start_seconds,
                         "end": segment["end"] + start_seconds} for segment in segments]
        else:
            client, model = _whisper_client()
            with client:
                segments = _whisper_file(client, audio, model, offset=start_seconds, **({"language": language} if language else {}))
    return segments_within_interval(segments, start_seconds, duration_seconds)


def _whisper_client():
    from openai import OpenAI

    backend = (env_str("WHISPER_BACKEND") or ("openrouter" if (env_str("OPENROUTER_API_KEY") or env_str("OPENROUTER_FEDERATION_POLICY_ID")) else "openai")).lower()
    if backend == "local":
        client = OpenAI(
            api_key=env_str("OPENAI_API_KEY") or "dummy-key-for-local",
            base_url=env_str("WHISPER_LOCAL_URL", "http://127.0.0.1:8080"),
            # Local CPU requests may contain several sequential VAD spans.
            # Leave transport margin around the gateway's bounded 600s budget.
            timeout=660.0, max_retries=2,
        )
        model = "whisper-local"
    elif backend == "openrouter":
        api_key = shared_api_key(OPENROUTER_BASE_URL) if env_str("OPENROUTER_FEDERATION_POLICY_ID") else env_str("OPENROUTER_API_KEY")
        if not api_key:
            raise RuntimeError("OPENROUTER_API_KEY is required for OpenRouter Whisper")
        client = OpenAI(api_key=api_key, base_url="https://openrouter.ai/api/v1", timeout=120.0, max_retries=2)
        model = "openai/whisper-large-v3-turbo"
    elif backend == "openai":
        api_key = env_str("OPENAI_API_KEY")
        if not api_key:
            raise RuntimeError("OPENAI_API_KEY is required for OpenAI Whisper")
        client = OpenAI(api_key=api_key, base_url="https://api.openai.com/v1", timeout=120.0, max_retries=2)
        model = "whisper-1"
    else:
        raise RuntimeError("Unsupported WHISPER_BACKEND; configure openrouter, openai or local")
    return client, model


def _whisper_transcribe(audio_path: Path, *, language: str | None = None) -> list[dict[str, Any]]:
    if env_str("WHISPER_BACKEND") == "workers-ai":
        return _workers_ai_transcribe(audio_path, language=language)
    client, model = _whisper_client()
    with client:
        # Whisper API soft limit ~25MB; split longer audio into ~10min chunks if needed.
        size_mb = audio_path.stat().st_size / (1024 * 1024)
        if size_mb <= 24:
            return _whisper_file(client, audio_path, model, offset=0.0, **({"language": language} if language else {}))

        all_segments: list[dict[str, Any]] = []
        with closing(_split_audio_chunks(audio_path, chunk_seconds=600)) as chunks:
            for offset, chunk_path in chunks:
                all_segments.extend(
                    _whisper_file(client, chunk_path, model, offset=offset, **({"language": language} if language else {}))
                )
        return all_segments


def _workers_ai_transcribe(audio_path: Path, *, language: str | None = None) -> list[dict[str, Any]]:
    from .workers_ai_transcription import transcribe_file

    duration = _ffprobe_duration(audio_path)
    if duration <= 300.5:
        return transcribe_file(audio_path, duration, language=language)
    segments = []
    with closing(_split_audio_chunks(audio_path, chunk_seconds=300)) as chunks:
        for offset, chunk in chunks:
            for segment in transcribe_file(chunk, _ffprobe_duration(chunk), language=language):
                segments.append({**segment, "start": segment["start"] + offset, "end": segment["end"] + offset})
    return segments_within_interval(segments, 0, duration)


def _whisper_file(
    client: Any, audio_path: Path, model: str, *, offset: float, language: str | None = None
) -> list[dict[str, Any]]:
    if model == "openai/whisper-large-v3-turbo" and env_str("OPENROUTER_FEDERATION_POLICY_ID"):
        # A warm worker can process several chunks after the initial client is created.
        client.api_key = shared_api_key(OPENROUTER_BASE_URL)
    with audio_path.open("rb") as fh:
        result = client.audio.transcriptions.create(
            model=model,
            file=fh,
            response_format="verbose_json",
            timestamp_granularities=["segment"],
            **({"language": language} if language else {}),
        )
    segments = getattr(result, "segments", None) or []
    out: list[dict[str, Any]] = []
    for seg in segments:
        if isinstance(seg, dict):
            start = float(seg.get("start", 0))
            end = float(seg.get("end", start))
            text = str(seg.get("text", ""))
        else:
            start = float(getattr(seg, "start", 0))
            end = float(getattr(seg, "end", start))
            text = str(getattr(seg, "text", ""))
        out.append({"start": start + offset, "end": end + offset, "text": text})
    if not out and getattr(result, "text", None):
        raise RuntimeError("Whisper must return real segment timestamps")
    return out


def _split_audio_chunks(
    audio_path: Path, chunk_seconds: int
) -> Generator[tuple[float, Path], None, None]:
    """Keep one temporary chunk until it is consumed or transcription fails."""
    duration = _ffprobe_duration(audio_path)
    start = 0.0
    idx = 0
    while start < duration:
        out = audio_path.with_name(f"chunk_{idx}.mp3")
        cmd = [
            "ffmpeg",
            "-nostdin",
            "-v", "error",
            "-y",
            "-ss",
            str(start),
            "-t",
            str(chunk_seconds),
            *MEDIA_INPUT_OPTIONS,
            "-i",
            str(audio_path),
            "-acodec",
            "copy",
            str(out),
        ]
        try:
            proc = run_media_process(cmd)
            if proc.returncode != 0:
                raise RuntimeError(f"ffmpeg chunk split failed: {proc.stderr[-500:]}")
            yield start, out
        finally:
            out.unlink(missing_ok=True)
        start += chunk_seconds
        idx += 1


def _ffprobe_duration(path: Path | ObjectMediaSource) -> float:
    cmd = [
        "ffprobe",
        "-v",
        "error",
        "-show_entries",
        "format=duration",
        "-of",
        "default=noprint_wrappers=1:nokey=1",
        *media_input_args(path),
    ]
    proc = run_media_process(cmd)
    if proc.returncode != 0:
        raise RuntimeError(f"ffprobe failed: {proc.stderr[-500:]}")
    duration = float(proc.stdout.strip())
    if not math.isfinite(duration) or duration <= 0:
        raise RuntimeError("ffprobe returned an invalid media duration")
    return duration


def ensure_audio_stream(path: Path | ObjectMediaSource) -> None:
    """Reject video-only uploads before reserving quota or sending chunk jobs."""
    proc = run_media_process([
        "ffprobe", "-v", "error", "-select_streams", "a",
        "-show_entries", "stream=index", "-of", "csv=p=0",
        *media_input_args(path),
    ])
    if proc.returncode != 0:
        raise RuntimeError(f"ffprobe failed: {proc.stderr[-500:]}")
    if not proc.stdout.strip():
        raise NoAudioStreamError(NO_AUDIO_MESSAGE)


def _transcribe_youtube(
    youtube_video_id: str, api_key: str | None
) -> tuple[str, float]:
    key = (api_key or "").strip()
    if not key:
        raise RuntimeError(
            "TranscriptAPI API key is not configured. Set your TranscriptAPI API key in "
            "Settings before importing YouTube videos."
        )
    transcript = _fetch_youtube_transcript(youtube_video_id, key)
    blocks: list[str] = []
    max_end = 0.0
    for index, item in enumerate(transcript, start=1):
        start = float(item.get("start", 0))
        duration = float(item.get("duration", 0))
        text = str(item.get("text", "")).replace("\n", " ").strip()
        if not text:
            continue
        start_ms = int(start * 1000)
        end_ms = int((start + duration) * 1000)
        max_end = max(max_end, start + duration)
        blocks.append(
            f"{index}\n"
            f"{format_srt_time(start_ms / 1000)} --> {format_srt_time(end_ms / 1000)}\n"
            f"{text}"
        )
    if not blocks:
        raise RuntimeError("No transcript available for this YouTube video.")
    return "\n\n".join(blocks) + "\n", max_end


def _fetch_youtube_transcript(youtube_video_id: str, api_key: str) -> list[dict]:
    base_url = env_str(
        "TRANSCRIPTAPI_BASE_URL", "https://transcriptapi.com/api/v2"
    ).rstrip("/")
    timeout = int(env_str("TRANSCRIPTAPI_TIMEOUT_SECONDS", "60") or "60")

    def request(endpoint: str, params: dict) -> dict:
        req = Request(
            f"{base_url}/youtube/{endpoint}?{urlencode(params)}",
            headers={"Authorization": f"Bearer {api_key}", "Accept": "application/json"},
        )
        try:
            with urlopen(req, timeout=timeout) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except HTTPError as exc:
            with exc:
                detail = exc.read(1200).decode("utf-8", errors="replace")[:300]
            raise RuntimeError(f"TranscriptAPI HTTP {exc.code}: {detail}") from exc
        except URLError as exc:
            raise RuntimeError(f"TranscriptAPI unreachable: {exc}") from exc

    # Discover tracks instead of accepting TranscriptAPI's English-first default.
    # Keep the existing manual-first, then automatic caption selection.
    info = request("info", {"video_url": youtube_video_id})
    tracks = [track for track in (info.get("available_languages") or [])
              if isinstance(track, dict)]
    manual = [track for track in tracks if track.get("kind") == "manual"]
    automatic = [track for track in tracks if track.get("kind") == "auto"]
    last_error: RuntimeError | None = None
    for candidates in (manual, automatic):
        # SearchAPI defaulted to English, then the first available track.
        candidates = sorted(candidates, key=lambda track: (
            str(track.get("code", "")).removeprefix("asr-").split("-")[0].lower() != "en"
        ))
        for track in candidates[:1]:
            code = track.get("code")
            if not code:
                continue
            if track.get("kind") == "auto" and not code.startswith("asr-"):
                code = f"asr-{code}"
            try:
                payload = request("transcript", {
                    "video_url": youtube_video_id,
                    "format": "json",
                    "include_timestamp": "true",
                    "language": code,
                    "language_fallback": "false",
                })
            except RuntimeError as exc:
                if isinstance(exc.__cause__, URLError) and not isinstance(exc.__cause__, HTTPError):
                    raise
                last_error = exc
                continue
            transcript = payload.get("transcript") or []
            if transcript:
                return transcript
    if last_error:
        raise last_error
    raise RuntimeError("No transcript available for this YouTube video.")
