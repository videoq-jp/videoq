"""Transcription planning and source ownership, independent of persistence."""

from dataclasses import dataclass
import math

CHUNK_SECONDS = 300
MAX_VIDEO_DURATION_SECONDS = 3_000_000
TRANSCRIPTION_LANES = 4


@dataclass(frozen=True)
class TranscriptionRun:
    video_id: int
    run_id: str
    file_key: str
    transcript_hash: str
    duration_ms: int
    chunk_seconds: int
    chunk_count: int
    completed: bool
    transcription_language: str | None = None


class TranscriptionQuotaError(RuntimeError):
    pass


def source_duration_ms(duration: float, file_key: str | None, transcript_hash: str | None) -> int:
    if not math.isfinite(duration) or not 0 < duration <= MAX_VIDEO_DURATION_SECONDS:
        raise ValueError("Video duration exceeds the supported transcription range")
    if not file_key or not transcript_hash:
        raise ValueError("Transcription needs a source and transcript fingerprint")
    return math.ceil(duration * 1000)


def validate_chunk_seconds(seconds: int) -> int:
    if not 30 <= seconds <= CHUNK_SECONDS:
        raise ValueError("WHISPER_CHUNK_SECONDS must be an integer from 30 to 300")
    return seconds


def checkpoint_count(duration_ms: int, chunk_seconds: int) -> int:
    count = math.ceil(duration_ms / (chunk_seconds * 1000))
    if count > 10000:
        raise ValueError("Transcription plan exceeds the 10,000-checkpoint limit")
    return count


def source_is_current(status: str, file_key: str | None, transcript_hash: str,
                      expected_file: str, expected_hash: str) -> bool:
    return (status in {"pending", "processing", "error"}
            and file_key == expected_file and transcript_hash == expected_hash)


def can_resume(run: TranscriptionRun | None, file_key: str, transcript_hash: str) -> bool:
    return bool(run and not run.completed
                and (run.file_key, run.transcript_hash) == (file_key, transcript_hash))


def run_is_current(run: TranscriptionRun, *, status: str, file_key: str | None,
                   transcript_hash: str, run_id: str | None, completed: bool) -> bool:
    return (not completed and run_id == run.run_id
            and source_is_current(status, file_key, transcript_hash, run.file_key, run.transcript_hash))


def can_reject_source(*, status: str, file_key: str | None, transcript_hash: str,
                      expected_file: str, expected_hash: str, run_id: str | None,
                      expected_run_id: str | None, completed: bool) -> bool:
    return (source_is_current(status, file_key, transcript_hash, expected_file, expected_hash)
            and (expected_run_id is None or (run_id == expected_run_id and not completed)))


def terminal_chunk_failure(index: int, failures: int, error: str) -> str | None:
    if failures < 5:
        return None
    return f"Transcription chunk {index + 1} failed: {error[:1000]}"


def assemble_segments(chunk_count: int, chunks: list[list[dict] | None]) -> list[dict] | None:
    if len(chunks) != chunk_count or any(chunk is None for chunk in chunks):
        return None
    return [segment for chunk in chunks if chunk is not None for segment in chunk]
