"""Manual transcript replacement policy; storage and locking are adapters."""
from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Callable, Generic, Protocol, TypeVar

logger = logging.getLogger(__name__)


class TranscriptVideo(Protocol):
    @property
    def transcript(self) -> str | None: ...


Video = TypeVar("Video", bound=TranscriptVideo)


@dataclass(frozen=True)
class ReindexTranscriptDependencies(Generic[Video]):
    load: Callable[[int], Video | None]
    index: Callable[[Video], object]
    delete: Callable[[int], object]


def execute_reindex_transcript(video_id: int, deps: ReindexTranscriptDependencies[Video]) -> None:
    video = deps.load(video_id)
    if video is None:
        logger.warning("ReindexVideoTranscript: video %d not found, skipping", video_id)
        return
    if video.transcript and video.transcript.strip():
        deps.index(video)
        logger.info("Successfully reindexed transcript for video %d", video_id)
    else:
        deps.delete(video_id)
        logger.info("Transcript cleared for video %d; vectors deleted, no reindex", video_id)
