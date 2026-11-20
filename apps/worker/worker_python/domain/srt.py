"""Shared SRT parsing and formatting for transcription, scenes and indexing."""

from __future__ import annotations

import re
from collections.abc import Iterator
from dataclasses import dataclass


@dataclass
class SrtScene:
    index: int
    start_time: str
    end_time: str
    start_sec: float
    end_sec: float
    text: str


def parse_srt_timestamp(timestamp: str) -> float:
    match = re.fullmatch(
        r"([0-9]{2,}):([0-5][0-9]):([0-5][0-9])[,.]([0-9]{3})", timestamp
    )
    if match is None:
        raise ValueError(f"Invalid timestamp: {timestamp}")
    hours, minutes, seconds, millis = map(int, match.groups())
    total_millis = ((hours * 60 + minutes) * 60 + seconds) * 1000 + millis
    # Keep the same exact millisecond range as the TypeScript consumers.
    if total_millis > 2**53 - 1:
        raise ValueError(f"Timestamp out of range: {timestamp}")
    return total_millis / 1000.0


def format_srt_time(seconds: float) -> str:
    total_millis = round(max(seconds, 0.0) * 1000)
    hours, remainder = divmod(total_millis, 3_600_000)
    minutes, remainder = divmod(remainder, 60_000)
    whole, millis = divmod(remainder, 1000)
    return f"{hours:02d}:{minutes:02d}:{whole:02d},{millis:03d}"


def create_srt_from_whisper_segments(segments: list[dict]) -> str:
    lines: list[str] = []
    for i, seg in enumerate(segments, start=1):
        text = str(seg.get("text", "")).strip()
        if not text:
            continue
        start = float(seg.get("start", 0))
        end = float(seg.get("end", start))
        lines.append(str(i))
        lines.append(f"{format_srt_time(start)} --> {format_srt_time(end)}")
        lines.append(text)
        lines.append("")
    return "\n".join(lines)


def parse_srt_scenes(srt_string: str) -> list[SrtScene]:
    return list(iter_srt_scenes(srt_string))


def _iter_srt_blocks(srt_string: str) -> Iterator[str]:
    content = srt_string.lstrip("\ufeff").replace("\r\n", "\n").replace("\r", "\n").strip()
    start = 0
    for separator in re.finditer(r"\n[ \t]*\n", content):
        yield content[start : separator.start()]
        start = separator.end()
    yield content[start:]


def iter_srt_scenes(srt_string: str) -> Iterator[SrtScene]:
    """Yield valid scenes so bounded consumers can stop without parsing the rest."""
    for block in _iter_srt_blocks(srt_string):
        block = block.strip()
        if not block:
            continue
        lines = block.split("\n")
        if len(lines) < 3:
            continue
        if not re.fullmatch(r"[+-]?[0-9]+", lines[0].strip()):
            continue
        try:
            index = int(lines[0].strip())
        except ValueError:
            continue
        timing = lines[1].strip()
        if "-->" not in timing:
            continue
        start_str, end_str = [t.strip() for t in timing.split("-->", 1)]
        text = "\n".join(lines[2:]).strip()
        if not text:
            continue
        try:
            start_sec = parse_srt_timestamp(start_str)
            end_sec = parse_srt_timestamp(end_str)
        except ValueError:
            continue
        if end_sec < start_sec:
            continue
        yield SrtScene(
            index=index,
            start_time=start_str,
            end_time=end_str,
            start_sec=start_sec,
            end_sec=end_sec,
            text=text,
        )
