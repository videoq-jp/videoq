from dataclasses import replace
from unittest.mock import Mock

import pytest

from worker_python.use_cases.uploaded_transcription import (
    UploadedTranscriptionDependencies, execute_uploaded_transcription,
)


def dependencies():
    return UploadedTranscriptionDependencies(
        duration=Mock(return_value=60.1), reserve=Mock(), extract_audio=Mock(),
        recognize=Mock(return_value=[{"start": 3.25, "end": 4.5, "text": " Original cue "}]),
        optional_visuals=Mock(return_value=()), report_visual_failure=Mock(),
    )


@pytest.mark.parametrize("duration,seconds", [(0.1, 1), (60.1, 61)])
def test_quota_denial_prevents_audio_model_and_cache_work(duration, seconds):
    deps = replace(dependencies(), duration=Mock(return_value=duration))
    deps.reserve.side_effect = RuntimeError("quota denied")
    with pytest.raises(RuntimeError, match="quota denied"):
        execute_uploaded_transcription(deps)
    deps.reserve.assert_called_once_with(seconds)
    deps.extract_audio.assert_not_called()
    deps.recognize.assert_not_called()
    deps.optional_visuals.assert_not_called()


def test_optional_cache_failures_are_independent_and_preserve_source_cues():
    deps = dependencies()
    first = Mock(side_effect=ValueError("private storage error"))
    second = Mock(side_effect=RuntimeError("private model details"))
    deps.optional_visuals.return_value = (("Frame", first), ("Focus", second))
    result = execute_uploaded_transcription(deps)
    assert "00:00:03,250 --> 00:00:04,500\nOriginal cue" in result
    first.assert_called_once_with(60.1)
    second.assert_called_once_with(60.1)
    assert deps.report_visual_failure.call_args_list == [
        (("Frame", "ValueError"),), (("Focus", "RuntimeError"),),
    ]


def test_empty_transcription_never_publishes_visuals_as_successful_output():
    deps = dependencies()
    deps.recognize.return_value = [{"start": 0, "end": 1, "text": " "}]
    with pytest.raises(RuntimeError, match="empty transcript"):
        execute_uploaded_transcription(deps)
    deps.optional_visuals.assert_not_called()


def test_audio_failure_does_not_call_model_or_publish_caches():
    deps = dependencies()
    deps.extract_audio.side_effect = RuntimeError("truncated media")
    with pytest.raises(RuntimeError, match="truncated media"):
        execute_uploaded_transcription(deps)
    deps.recognize.assert_not_called()
    deps.optional_visuals.assert_not_called()


def test_reservation_precedes_model_and_optional_work_without_changing_timestamps():
    deps = dependencies()
    calls = Mock()
    for name in ("duration", "reserve", "extract_audio", "recognize", "optional_visuals"):
        calls.attach_mock(getattr(deps, name), name)
    assert execute_uploaded_transcription(deps).startswith("1\n00:00:03,250")
    assert [call[0] for call in calls.mock_calls] == [
        "duration", "reserve", "extract_audio", "recognize", "optional_visuals",
    ]
