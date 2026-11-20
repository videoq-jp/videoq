"""Source-relative evidence boundaries, independent of the recognition provider."""
import math


def segments_within_interval(segments: list[dict], start_seconds: float, duration_seconds: float) -> list[dict]:
    end_seconds = start_seconds + duration_seconds
    result = []
    for segment in segments:
        start, end = float(segment["start"]), float(segment["end"])
        if not math.isfinite(start) or not math.isfinite(end):
            # Preserve the existing public failure diagnostic.
            raise RuntimeError("Whisper returned non-finite timestamps")
        start, end = max(start_seconds, start), min(end_seconds, end)
        if start < end and segment["text"].strip():
            result.append({"start": start, "end": end, "text": segment["text"]})
    return result
