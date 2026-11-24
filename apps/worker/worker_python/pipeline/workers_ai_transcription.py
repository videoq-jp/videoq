"""Bounded audio transport; Workers AI inference and normalization live in Hono."""
import base64
import math
from pathlib import Path

from worker_python.internal_api import call_internal_api

MODEL = "@cf/openai/whisper-large-v3-turbo"
MAX_AUDIO_BYTES = 3_000_000


def transcribe_file(audio: Path, duration: float, *, language: str | None = None) -> list[dict]:
    if not math.isfinite(duration) or not 0 < duration <= 300.5:
        raise ValueError("Invalid Workers AI audio duration")
    if not 0 < audio.stat().st_size <= MAX_AUDIO_BYTES:
        raise ValueError("Workers AI audio chunk is too large or empty")
    with audio.open("rb") as source:
        content = source.read(MAX_AUDIO_BYTES + 1)
    if not 0 < len(content) <= MAX_AUDIO_BYTES:
        raise ValueError("Workers AI audio chunk is too large or empty")
    response = call_internal_api("audio/transcribe", {
        "model": MODEL, "audio": base64.b64encode(content).decode("ascii"),
        "durationSeconds": duration, **({"language": language} if language else {}),
    })
    segments = response.get("segments")
    if response.get("model") != MODEL or not isinstance(segments, list) or len(segments) > 2000:
        raise RuntimeError("Invalid Workers AI transcription response")
    previous = 0.0
    for segment in segments:
        if (not isinstance(segment, dict) or set(segment) != {"start", "end", "text"}
                or any(type(segment.get(k)) not in {int, float} for k in ("start", "end"))
                or not isinstance(segment.get("text"), str)):
            raise RuntimeError("Invalid Workers AI transcription response")
        start, end = segment["start"], segment["end"]
        if (not math.isfinite(start) or not math.isfinite(end)
                or not previous <= start < end <= duration or not segment["text"].strip()):
            raise RuntimeError("Invalid Workers AI transcription timestamps")
        previous = start
    return segments
