from dataclasses import replace
from unittest.mock import Mock

import pytest
from worker_python.use_cases.cloud_transcription import CloudTranscriptionDependencies, execute_cloud_transcription
from worker_python.use_cases.transcription import ProcessingQuotaExceededError, TranscriptionExecutionFailedError


def dependencies(status="pending"):
    return CloudTranscriptionDependencies(
        load=Mock(return_value=status), status=lambda source: source,
        prepare=Mock(return_value="video"), is_uploaded=lambda video: False,
        start_segmented=Mock(), begin=Mock(return_value=True),
        transcribe=Mock(return_value="transcript"), finish=Mock(return_value="indexing"), segmented_enabled=False,
    )


@pytest.mark.parametrize("status", ["indexing", "completed"])
def test_committed_source_never_restarts_provider_or_queues_again(status):
    deps = dependencies(status)
    execute_cloud_transcription(1, deps)
    deps.prepare.assert_not_called()
    deps.begin.assert_not_called()
    deps.transcribe.assert_not_called()
    deps.finish.assert_not_called()


def test_changed_source_fails_before_provider_and_does_not_overwrite_winner():
    deps = dependencies("processing")
    deps.begin.return_value = False
    with pytest.raises(TranscriptionExecutionFailedError, match="source changed"):
        execute_cloud_transcription(1, deps)
    deps.transcribe.assert_not_called()
    deps.finish.assert_not_called()


@pytest.mark.parametrize("failure,code,retry", [
    (ProcessingQuotaExceededError("private quota detail"), "PROCESSING_QUOTA_EXCEEDED", False),
    (RuntimeError("secret provider token"), "TRANSCRIPTION_FAILED", True),
])
def test_failure_save_contains_only_safe_code_and_retries_only_provider_error(failure, code, retry):
    deps = dependencies()
    deps.transcribe.side_effect = failure
    deps.finish.return_value = "error"
    if retry:
        with pytest.raises(TranscriptionExecutionFailedError, match="Cloud transcription failed; retry"):
            execute_cloud_transcription(1, deps)
    else:
        execute_cloud_transcription(1, deps)
    deps.finish.assert_called_once_with("video", None, code)


def test_segmented_source_hands_off_without_starting_a_second_transcription():
    deps = replace(dependencies(), segmented_enabled=True, is_uploaded=lambda video: True)
    execute_cloud_transcription(1, deps)
    deps.start_segmented.assert_called_once_with("video")
    deps.begin.assert_not_called()
    deps.transcribe.assert_not_called()
