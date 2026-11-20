"""Transcription source selection and quota handoff without media/provider SDKs."""
from dataclasses import dataclass
import math
from typing import Callable, Generic, Protocol, TypeVar


class TranscriptionMedia(Protocol):
    id: int
    source_type: str
    youtube_video_id: str | None
    file_key: str | None
    transcription_language: str | None


Video = TypeVar("Video", bound=TranscriptionMedia)


@dataclass(frozen=True)
class TranscriptionSourceDependencies(Generic[Video]):
    youtube: Callable[[str], tuple[str, float]]
    uploaded: Callable[[Video], str]
    placeholder: Callable[[], str]
    reserve: Callable[[int], None] | None
    real_enabled: bool
    youtube_allowed: bool


def require_transcription_source_allowed(source_type: str, youtube_allowed: bool) -> None:
    if source_type == "youtube" and not youtube_allowed:
        raise RuntimeError("YouTube integration is disabled in the on-prem edition")


def transcribe_source(video: Video, deps: TranscriptionSourceDependencies[Video]) -> str:
    require_transcription_source_allowed(video.source_type, deps.youtube_allowed)
    if not deps.real_enabled:
        if deps.reserve:
            deps.reserve(1)
        return deps.placeholder()
    if video.source_type == "youtube":
        if not video.youtube_video_id:
            raise RuntimeError("youtube_video_id is required for YouTube transcription.")
        transcript, duration = deps.youtube(video.youtube_video_id)
        if deps.reserve:
            deps.reserve(max(1, math.ceil(duration)))
        return transcript
    if not video.file_key:
        raise RuntimeError(f"Video {video.id} has no file key for uploaded transcription.")
    return deps.uploaded(video)
