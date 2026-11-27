"""Visual plans and source ownership without persistence or media decoders."""
from dataclasses import dataclass
import math
from typing import Callable, Generic, TypeVar

CHUNK_SECONDS = 60
MAX_DURATION_SECONDS = 36_000


@dataclass(frozen=True)
class VisualRun:
    video_id: int
    run_id: str
    file_key: str
    duration_ms: int
    chunk_count: int
    status: str


def validate_visual_duration(duration: float, maximum: float = MAX_DURATION_SECONDS) -> None:
    if not math.isfinite(duration) or not 0 < duration <= maximum:
        raise ValueError('Visual inspection supports videos up to 10 hours')


def visual_plan(duration: float, maximum: float = MAX_DURATION_SECONDS) -> tuple[int, int]:
    validate_visual_duration(duration, maximum)
    duration_ms = math.ceil(duration * 1000)
    return duration_ms, math.ceil(duration_ms / (CHUNK_SECONDS * 1000))


def visual_chunk_window(duration: float, index: int) -> tuple[int, float]:
    validate_visual_duration(duration)
    if type(index) is not int or not 0 <= index < math.ceil(duration / CHUNK_SECONDS):
        raise ValueError('Invalid visual chunk index')
    return index * CHUNK_SECONDS, min((index + 1) * CHUNK_SECONDS, duration)


def visual_sample_targets(duration: float, start: int, end: float) -> list[float]:
    interval = max(5, duration / 240)
    return [i * interval for i in range(240) if start <= i * interval < end]


def visual_source_eligible(file_key: str, current_file: str, source_type: str) -> bool:
    return file_key == current_file and source_type == 'uploaded'


def visual_run_reusable(run: VisualRun | None, file_key: str) -> bool:
    # Ready runs also remain reusable; another delivery must not replace them.
    return run is not None and run.file_key == file_key


def visual_run_owns_source(run: VisualRun, run_id: str, run_file: str, current_file: str) -> bool:
    # The PG write fence has historically checked these identities, without
    # introducing a status or source-type admission check at this stage.
    return run_id == run.run_id and current_file == run_file == run.file_key


Predicate = TypeVar('Predicate')


@dataclass(frozen=True)
class VisualChunkPublication(Generic[Predicate]):
    chunk_error: str
    run_status: str
    run_error: str
    recover_run: Predicate


def visual_chunk_publication(has_failed_chunks: Predicate, negate: Callable[[Predicate], Predicate]) -> VisualChunkPublication[Predicate]:
    # A successful chunk clears its own failure; other failed chunks retain the
    # run's error state until each has been successfully retried.
    return VisualChunkPublication('', 'processing', '', negate(has_failed_chunks))


@dataclass(frozen=True)
class VisualRunPublication:
    status: str = 'ready'
    error: str = ''
