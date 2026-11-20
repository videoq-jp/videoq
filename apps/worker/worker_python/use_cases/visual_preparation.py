"""Visual preparation lifecycle without media, SQL or queue implementations."""
from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Callable, Generic, Protocol, TypeVar


class VisualPreparationRun(Protocol):
    @property
    def file_key(self) -> str: ...
    @property
    def run_id(self) -> str: ...
    @property
    def status(self) -> str: ...
    @property
    def chunk_count(self) -> int: ...


Run = TypeVar("Run", bound=VisualPreparationRun)


@dataclass(frozen=True)
class VisualPreparationDependencies(Generic[Run]):
    load_source: Callable[[int], tuple[str | None, str | None, str | None]]
    load_run: Callable[[int, str | None], Run | None]
    duration: Callable[[str], float]
    initialize: Callable[[int, str, float], Run | None]
    dispatch: Callable[[Run], None]
    build: Callable[[int, str, int], None]
    finish: Callable[[int, str], None]
    queued: bool
    max_duration_seconds: float


def execute_visual_preparation(video_id: int, deps: VisualPreparationDependencies[Run], *, dry_run: bool = False) -> dict:
    if video_id <= 0:
        raise ValueError("A positive video ID is required")
    kind, file_key, status = deps.load_source(video_id)
    if kind != "uploaded" or not isinstance(file_key, str) or not file_key or status != "completed":
        raise ValueError("An existing completed uploaded video is required")
    existing = deps.load_run(video_id, None)
    if existing and existing.file_key == file_key and existing.status == "ready":
        return {"video_id": video_id, "visual_preparation": "ready", "chunks": existing.chunk_count}
    duration = deps.duration(file_key)
    if not math.isfinite(duration) or not 0 < duration <= deps.max_duration_seconds:
        raise ValueError("Visual inspection supports videos up to 10 hours")
    if dry_run:
        return {"video_id": video_id, "visual_preparation": "dry_run", "chunks": math.ceil(duration / 60)}
    run = deps.initialize(video_id, file_key, duration)
    if not run:
        raise ValueError("Video source changed before preparation")
    if run.status == "ready":
        return {"video_id": video_id, "visual_preparation": "ready", "chunks": run.chunk_count}
    if deps.queued:
        deps.dispatch(run)
        return {"video_id": video_id, "visual_preparation": "queued", "chunks": run.chunk_count}
    for index in range(run.chunk_count):
        deps.build(video_id, run.run_id, index)
    deps.finish(video_id, run.run_id)
    current = deps.load_run(video_id, run.run_id)
    if not current or current.status != "ready":
        raise RuntimeError("Visual publication did not become ready; retry preparation")
    return {"video_id": video_id, "visual_preparation": "ready", "chunks": run.chunk_count}
