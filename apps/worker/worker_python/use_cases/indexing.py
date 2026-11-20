"""Transcript indexing lifecycle, independent of databases and providers."""
from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Callable, Generic, Protocol, TypeVar

from worker_python.domain.video_status import VideoStatus

logger = logging.getLogger(__name__)


class IndexingExecutionFailedError(Exception):
    """Raised when indexing fails and retry is allowed."""


class IndexingVideo(Protocol):
    @property
    def status(self) -> str: ...
    @property
    def transcript(self) -> str | None: ...


Video = TypeVar("Video", bound=IndexingVideo)


@dataclass(frozen=True)
class IndexingDependencies(Generic[Video]):
    load: Callable[[int], Video | None]
    index: Callable[[Video], object]
    clear: Callable[[Video], object]
    finish: Callable[[Video], tuple[bool, Video | None]]


def execute_indexing(video_id: int, deps: IndexingDependencies[Video], *, allow_empty: bool = False) -> None:
    video = deps.load(video_id)

    if video is None:
        logger.info("Video %d was deleted; skipping indexing", video_id)
        return
    if video.status == VideoStatus.COMPLETED.value:
        logger.info("Video %d is already indexed", video_id)
        return

    if video.status != VideoStatus.INDEXING.value:
        raise IndexingExecutionFailedError(
            f"Video {video_id} is not ready for indexing (status={video.status})"
        )
    try:
        if allow_empty is True and not (video.transcript or '').strip():
            deps.clear(video)
        else:
            deps.index(video)
    except Exception as exc:
        raise IndexingExecutionFailedError(
            f"Vector indexing failed for video {video_id}: {exc}"
        ) from exc

    updated, current = deps.finish(video)
    if not updated and current is not None and current.status == VideoStatus.INDEXING.value:
        raise IndexingExecutionFailedError('Transcript changed before indexing completion; retry')

    if not updated:
        logger.warning(
            "Video %d was not in %s status during indexing completion",
            video_id,
            VideoStatus.INDEXING.value,
        )

    logger.info("Successfully indexed video %d", video_id)
