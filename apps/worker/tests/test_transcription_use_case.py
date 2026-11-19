"""Lifecycle decisions run with capabilities and plain metadata, without provider/DB setup."""
from dataclasses import dataclass
from unittest.mock import Mock

import pytest

from worker_python.use_cases.transcription import (
    ProcessingQuotaExceededError,
    TranscriptionDependencies,
    TranscriptionExecutionFailedError,
    execute_transcription,
)


@dataclass
class Video:
    id: int = 42
    title: str = "Lesson"
    status: str = "pending"
    source_type: str = "uploaded"


def dependencies(**overrides):
    ports = dict(
        load=Mock(return_value=Video()), begin=Mock(return_value=True),
        transcribe=Mock(return_value="Subtitles"), finish=Mock(return_value="indexing"),
        handoff=Mock(), start_segmented=Mock(), segmented_enabled=False,
    )
    ports.update(overrides)
    return TranscriptionDependencies(**ports)


def test_failed_claim_never_runs_provider_or_overwrites_the_new_owner():
    deps = dependencies(begin=Mock(return_value=False))
    with pytest.raises(TranscriptionExecutionFailedError, match="could not transition"):
        execute_transcription(42, deps)
    deps.transcribe.assert_not_called()
    deps.finish.assert_not_called()
    deps.handoff.assert_not_called()


@pytest.mark.parametrize("saved_status", ["completed", "deleted", "indexing"])
def test_concurrent_edits_determine_handoff_even_when_provider_fails(saved_status):
    failure = RuntimeError("Provider unavailable")
    deps = dependencies(transcribe=Mock(side_effect=failure), finish=Mock(return_value=saved_status))
    execute_transcription(42, deps, job_id="parent")
    assert deps.finish.call_args.args[1:] == (None, "Provider unavailable")
    if saved_status == "indexing":
        deps.handoff.assert_called_once_with(42, "parent")
    else:
        deps.handoff.assert_not_called()


@pytest.mark.parametrize("quota", [True, False])
def test_save_precedes_retry_and_quota_failures_do_not_retry(quota):
    failure = ProcessingQuotaExceededError("Quota") if quota else RuntimeError("Provider")
    deps = dependencies(transcribe=Mock(side_effect=failure), finish=Mock(return_value="error"))
    if quota:
        execute_transcription(42, deps)
    else:
        with pytest.raises(TranscriptionExecutionFailedError) as result:
            execute_transcription(42, deps)
        assert result.value.__cause__ is failure
    deps.finish.assert_called_once()
    deps.handoff.assert_not_called()


def test_queue_failure_retries_only_handoff_after_successful_save():
    video = Video()
    def save(*_args):
        video.status = "indexing"
        return video.status
    deps = dependencies(load=Mock(return_value=video), finish=Mock(side_effect=save),
                        handoff=Mock(side_effect=[RuntimeError("Queue unavailable"), None]))
    with pytest.raises(RuntimeError, match="Queue unavailable"):
        execute_transcription(42, deps, job_id="parent")
    execute_transcription(42, deps, job_id="parent")
    deps.transcribe.assert_called_once()
    deps.finish.assert_called_once()
    assert deps.handoff.call_count == 2
    assert deps.handoff.call_args.args == (42, "parent")


def test_segmented_upload_delegates_without_inline_provider_or_save():
    deps = dependencies(segmented_enabled=True)
    execute_transcription(42, deps)
    deps.start_segmented.assert_called_once()
    deps.begin.assert_not_called()
    deps.transcribe.assert_not_called()
    deps.finish.assert_not_called()
