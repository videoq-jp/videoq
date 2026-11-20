"""Bounded rebuild scheduling and failure aggregation without runtime I/O."""
from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Callable, Generic, Iterable, Protocol, TypeVar

logger = logging.getLogger(__name__)
REINDEX_PAGE_SIZE = 25


@dataclass(frozen=True)
class FullReindexDependencies:
    cloud: bool
    queued: bool
    dispatch_page: Callable[[int, str], None]
    inline: Callable[[], None]


def execute_full_reindex(
    deps: FullReindexDependencies, *, after_id: int = 0,
    root_job_id: str | None = None, job_id: str | None = None,
) -> None:
    if deps.cloud and not deps.queued:
        raise RuntimeError("Cloud full reindex requires a search queue")
    if deps.queued:
        if not job_id:
            raise ValueError("Queued full reindex requires a stable parent job_id")
        deps.dispatch_page(after_id, root_job_id or job_id)
        return
    deps.inline()


class ReindexingIncompleteError(RuntimeError):
    """At least one video failed; the parent job must be retried."""


class ReindexVideo(Protocol):
    @property
    def id(self) -> int: ...
    @property
    def title(self) -> str: ...


Video = TypeVar("Video", bound=ReindexVideo)


@dataclass(frozen=True)
class ReindexBatchDependencies(Generic[Video]):
    prepare: Callable[[], object]
    index: Callable[[Video], object]


def execute_reindex_batch(videos: Iterable[Video], deps: ReindexBatchDependencies[Video]) -> None:
    remaining = iter(videos)
    first = next(remaining, None)
    if first is None:
        logger.info("Re-indexing completed: No videos to re-index")
        return
    deps.prepare()

    def snapshots():
        yield first
        yield from remaining

    successful_count = 0
    failed_count = 0
    for total, video in enumerate(snapshots(), start=1):
        try:
            # Each replacement is atomic; a failed video must not erase others.
            deps.index(video)
            successful_count += 1
            logger.info("[%d] Re-indexed video %d (%s)", total, video.id, video.title)
        except Exception:
            logger.exception("Failed to re-index video %d", video.id)
            failed_count += 1
    message = f"Re-indexed {successful_count}/{total} videos"
    if failed_count:
        raise ReindexingIncompleteError(f"{message}; {failed_count} video(s) failed")
    logger.info("Re-indexing completed: %s", message)


def dispatch_reindex_page(
    ids: list[int], *, send_video: Callable[[int], None],
    send_continuation: Callable[[int], None],
) -> None:
    for identifier in ids[:REINDEX_PAGE_SIZE]:
        send_video(identifier)
    # Continuation must follow every child, so partial failure retries the page.
    if len(ids) > REINDEX_PAGE_SIZE:
        send_continuation(ids[REINDEX_PAGE_SIZE - 1])
