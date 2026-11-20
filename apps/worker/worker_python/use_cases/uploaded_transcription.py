"""Uploaded transcription sequencing, independent of files and model clients."""
from dataclasses import dataclass
import math
from typing import Callable

from worker_python.domain.srt import create_srt_from_whisper_segments


@dataclass(frozen=True)
class UploadedTranscriptionDependencies:
    duration: Callable[[], float]
    reserve: Callable[[int], None] | None
    extract_audio: Callable[[], None]
    recognize: Callable[[], list[dict]]
    optional_visuals: Callable[[], tuple[tuple[str, Callable[[float], None]], ...]]
    report_visual_failure: Callable[[str, str], None]


def execute_uploaded_transcription(deps: UploadedTranscriptionDependencies) -> str:
    duration = deps.duration()
    if deps.reserve:
        deps.reserve(max(1, math.ceil(duration)))
    deps.extract_audio()
    transcript = create_srt_from_whisper_segments(deps.recognize())
    if not transcript.strip():
        raise RuntimeError("Whisper returned an empty transcript")

    # Each optional cache may fail independently. A usable transcript survives,
    # and another cache still gets its chance to publish.
    for name, publish in deps.optional_visuals():
        try:
            publish(duration)
        except Exception as exc:
            deps.report_visual_failure(name, type(exc).__name__)
    return transcript
