"""Chunk scheduling, retry and completion decisions without runtime adapters."""
from dataclasses import dataclass
from typing import Callable, Generic, Protocol, TypeVar


class SegmentedVisualRun(Protocol):
    @property
    def status(self) -> str: ...
    @property
    def chunk_count(self) -> int: ...


Run = TypeVar('Run', bound=SegmentedVisualRun)


@dataclass(frozen=True)
class SegmentedVisualDependencies(Generic[Run]):
    initialize: Callable[[int, str, float], Run | None]
    load: Callable[[int, str], Run | None]
    pending: Callable[[Run], list[int]]
    complete: Callable[[Run, int], bool]
    build_and_publish: Callable[[Run, int], int | None]
    finish: Callable[[Run], None]
    send_chunk: Callable[[Run, int], None]
    send_finish: Callable[[Run], None]
    record_failure: Callable[[Run, Exception, int | None], None]


def dispatch_visuals(run: Run, deps: SegmentedVisualDependencies[Run]) -> None:
    if run.status == 'ready':
        return
    pending = deps.pending(run)
    # Fan out once; a chunk must never recursively invoke its successor.
    for index in pending:
        deps.send_chunk(run, index)
    if not pending:
        deps.send_finish(run)


def start_visuals(video_id: int, file_key: str, duration: float, deps: SegmentedVisualDependencies[Run]) -> None:
    run = deps.initialize(video_id, file_key, duration)
    if run:
        try:
            dispatch_visuals(run, deps)
        except Exception as error:
            deps.record_failure(run, error, None)
            raise


def build_visual(video_id: int, run_id: str, index: int, deps: SegmentedVisualDependencies[Run], *, dispatch_next: bool = True) -> None:
    run = deps.load(video_id, run_id)
    if not run or run.status == 'ready':
        return
    if not 0 <= index < run.chunk_count:
        raise ValueError('Invalid visual chunk index')
    try:
        if not deps.complete(run, index):
            if deps.build_and_publish(run, index) is None:
                return
        if dispatch_next and not deps.pending(run):
            deps.send_finish(run)
    except Exception as error:
        deps.record_failure(run, error, index)
        raise


def finish_visuals(video_id: int, run_id: str, deps: SegmentedVisualDependencies[Run]) -> None:
    run = deps.load(video_id, run_id)
    if not run or run.status == 'ready':
        return
    try:
        deps.finish(run)
    except Exception as error:
        deps.record_failure(run, error, None)
        raise
