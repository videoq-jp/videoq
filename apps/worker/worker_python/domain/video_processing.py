"""Processing reservations and completion policy, independent of SQL and runtime."""
from dataclasses import dataclass
from typing import Generic, Protocol, TypeVar

Value = TypeVar('Value')
Predicate = TypeVar('Predicate')


@dataclass
class VideoRow:
    id: int
    user_id: str
    title: str
    transcript: str | None
    status: str
    source_type: str
    file_key: str | None
    youtube_video_id: str | None
    transcript_hash: str | None = None
    transcription_language: str | None = None


@dataclass(frozen=True)
class ProcessingReservationResult:
    allowed: bool
    limit_seconds: int | None = None


def validate_processing_seconds(seconds: int) -> None:
    # Retain the established Python comparison; no new integer/type gate.
    if seconds <= 0:
        raise ValueError('processing seconds must be positive')


def processing_reservation_reused(video_id: int, stored_seconds: int | None) -> bool:
    if stored_seconds is None:
        raise ValueError(f'Video {video_id} not found')
    return stored_seconds > 0


def processing_reservation_denied(limit_minutes: int | None) -> ProcessingReservationResult:
    return ProcessingReservationResult(False, None if limit_minutes is None else limit_minutes * 60)


def require_transcription_fingerprint(fingerprint: str | None) -> None:
    if fingerprint is None:
        raise ValueError('Transcription requires the original transcript fingerprint')


class VideoProcessingLogic(Protocol[Value, Predicate]):
    def all(self, *terms: Predicate) -> Predicate: ...
    def any(self, *terms: Predicate) -> Predicate: ...
    def negate(self, term: Predicate) -> Predicate: ...
    def choose(self, condition: Predicate, yes: Value, no: Value) -> Value: ...
    def literal(self, value: str) -> Value: ...
    def number(self, value: int) -> Value: ...
    def add(self, left: Value, right: Value) -> Value: ...
    def subtract(self, left: Value, right: Value) -> Value: ...
    def multiply(self, left: Value, right: int) -> Value: ...
    def at_most(self, left: Value, right: Value) -> Predicate: ...
    def is_unlimited(self, value: Value) -> Predicate: ...


@dataclass(frozen=True)
class ProcessingUsage(Generic[Value]):
    current_seconds: Value
    next_seconds: Value
    next_ai_answers: Value
    next_period_start: Value


def processing_usage(
    reset_period: Predicate, used_seconds: Value, seconds: Value, used_ai_answers: Value,
    period_start: Value, now: Value, logic: VideoProcessingLogic[Value, Predicate],
) -> ProcessingUsage[Value]:
    return ProcessingUsage(
        logic.choose(reset_period, logic.number(0), used_seconds),
        logic.choose(reset_period, seconds, logic.add(used_seconds, seconds)),
        logic.choose(reset_period, logic.number(0), used_ai_answers),
        logic.choose(reset_period, now, period_start),
    )


def processing_quota_allowed(
    not_over_quota: Predicate, used_seconds: Value, limit_minutes: Value, seconds: Value,
    logic: VideoProcessingLogic[Value, Predicate],
) -> Predicate:
    return logic.all(not_over_quota, logic.any(logic.is_unlimited(limit_minutes),
        logic.at_most(used_seconds, logic.subtract(logic.multiply(limit_minutes, 60), seconds))))


@dataclass(frozen=True)
class TranscriptionCompletion(Generic[Value, Predicate]):
    save_transcript: Predicate
    status: Value
    error: Value
    allowed: Predicate


def transcription_completion(
    processing: Predicate, same_transcript: Predicate, has_result: Predicate, error: Value,
    logic: VideoProcessingLogic[Value, Predicate],
) -> TranscriptionCompletion[Value, Predicate]:
    return TranscriptionCompletion(
        logic.all(same_transcript, has_result),
        logic.choose(logic.negate(same_transcript), logic.literal('completed'),
            logic.choose(logic.negate(has_result), logic.literal('error'), logic.literal('indexing'))),
        logic.choose(logic.all(same_transcript, logic.negate(has_result)), error, logic.literal('')),
        processing,
    )


def transcription_admission(status: str | None) -> str:
    if status == 'completed':
        return 'completed'
    if status == 'indexing':
        return 'handoff'
    return 'process' if status in {'pending', 'processing', 'error'} else 'invalid'


def transcription_failure_retry(status: str | None, provider_failed: bool) -> bool:
    return status == 'error' and provider_failed


@dataclass(frozen=True)
class TranscriptionContent:
    transcript: str | None
    error: str
    processing_status: str = 'processing'


def prepared_transcription_content(transcript: str) -> TranscriptionContent:
    return TranscriptionContent(transcript, '') if transcript.strip() else TranscriptionContent(None, 'Whisper returned an empty transcript')
