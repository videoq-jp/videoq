"""Pure subtitle assembly and speech-boundary policies."""
from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Callable, Generic, TypeVar

RATE = 16000


def merge_speech_spans(regions):
    spans = []
    for region in regions:
        start, end = int(region["start"]), int(region["end"])
        # Merge overlapping padding only. Retaining detected pauses avoids a
        # decoder finishing after one utterance and silently dropping the next.
        if spans and start <= spans[-1][1] and end - spans[-1][0] <= 30 * RATE:
            spans[-1] = (spans[-1][0], end)
        else:
            spans.append((start, end))
    return spans


def restore_segments(parts, duration):
    result = []
    for start, end, payload in parts:
        if not isinstance(payload, dict) or not isinstance(payload.get("segments"), list):
            raise ValueError("Invalid upstream response")
        rows = payload.get("segments") or []
        if not rows and str(payload.get("text", "")).strip():
            raise ValueError("Upstream did not return real timestamps")
        previous = 0.0
        for row in rows:
            if not isinstance(row, dict) or type(row.get("start")) not in (int, float) or type(row.get("end")) not in (int, float):
                raise ValueError("Invalid upstream timestamps")
            left, right = float(row["start"]), float(row["end"])
            if not math.isfinite(left) or not math.isfinite(right) or left < previous or right < left:
                raise ValueError("Invalid upstream timestamps")
            previous = left
            text = row.get("text")
            if not isinstance(text, str):
                raise ValueError("Invalid upstream text")
            left = start / RATE + max(0, left)
            right = min(duration, end / RATE, start / RATE + right)
            if left < right and text.strip():
                result.append({"id": len(result), "start": left, "end": right, "text": text})
    return result


def transcription_result(parts, duration, language=None):
    segments = restore_segments(parts, duration)
    detected = next((part[2].get("language") for part in parts if isinstance(part[2].get("language"), str)), "unknown")
    return {"task": "transcribe", "language": language or detected, "duration": duration,
            "text": " ".join(row["text"].strip() for row in segments), "segments": segments}


Audio = TypeVar("Audio")


@dataclass(frozen=True)
class TranscriptionDependencies(Generic[Audio]):
    duration: Callable[[Audio], float]
    speech_spans: Callable[[Audio], list[tuple[int, int]]]
    recognize: Callable[[Audio, list[tuple[int, int]], str | None, float], list[tuple[int, int, dict]]]
    now: Callable[[], float]


def execute_transcription(audio: Audio, deps: TranscriptionDependencies[Audio], *, language: str | None, deadline: float):
    duration = deps.duration(audio)
    spans = deps.speech_spans(audio)
    parts = deps.recognize(audio, spans, language, deadline)
    if deps.now() > deadline:
        raise TimeoutError("Transcription deadline exceeded")
    return transcription_result(parts, duration, language)
