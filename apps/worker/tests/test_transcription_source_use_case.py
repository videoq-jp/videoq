from dataclasses import replace
from types import SimpleNamespace
from unittest.mock import Mock

import pytest
from worker_python.use_cases.transcription_source import TranscriptionSourceDependencies, transcribe_source


def dependencies():
    return TranscriptionSourceDependencies(
        youtube=Mock(return_value=("captions", 60.1)), uploaded=Mock(return_value="uploaded captions"),
        placeholder=Mock(return_value="placeholder"), reserve=Mock(), real_enabled=True, youtube_allowed=True,
    )


def video(source_type="youtube", **fields):
    return SimpleNamespace(id=1, source_type=source_type, youtube_video_id=fields.get("youtube_video_id", "yt"),
                           file_key=fields.get("file_key", "video.mp4"), transcription_language="ja")


def test_disabled_integration_does_not_call_provider_or_reserve_even_in_placeholder_mode():
    deps = replace(dependencies(), youtube_allowed=False, real_enabled=False)
    with pytest.raises(RuntimeError, match="disabled"):
        transcribe_source(video(), deps)
    deps.youtube.assert_not_called()
    deps.placeholder.assert_not_called()
    deps.reserve.assert_not_called()


def test_youtube_reserves_rounded_duration_after_caption_fetch_and_propagates_denial():
    deps = dependencies()
    deps.reserve.side_effect = RuntimeError("quota denied")
    with pytest.raises(RuntimeError, match="quota denied"):
        transcribe_source(video(), deps)
    deps.youtube.assert_called_once_with("yt")
    deps.reserve.assert_called_once_with(61)
    deps.uploaded.assert_not_called()


def test_placeholder_reserves_one_second_without_real_media_work():
    deps = replace(dependencies(), real_enabled=False)
    assert transcribe_source(video(), deps) == "placeholder"
    deps.reserve.assert_called_once_with(1)
    deps.youtube.assert_not_called()
    deps.uploaded.assert_not_called()


def test_uploaded_provider_owns_probe_and_quota_so_the_source_selector_does_not_double_charge():
    deps = dependencies()
    source = video("uploaded")
    assert transcribe_source(source, deps) == "uploaded captions"
    deps.uploaded.assert_called_once_with(source)
    deps.reserve.assert_not_called()


@pytest.mark.parametrize("source", [video(youtube_video_id=None), video("uploaded", file_key=None)])
def test_missing_source_identifier_never_calls_a_provider(source):
    deps = dependencies()
    with pytest.raises(RuntimeError):
        transcribe_source(source, deps)
    deps.youtube.assert_not_called()
    deps.uploaded.assert_not_called()
