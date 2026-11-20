from types import SimpleNamespace
from unittest.mock import Mock

import pytest

from worker_python.use_cases.reindex_transcript import (
    ReindexTranscriptDependencies, execute_reindex_transcript,
)


@pytest.mark.parametrize("transcript", [None, "", " \n", "subtitle"])
def test_manual_edit_replaces_or_deletes_index(transcript):
    video = SimpleNamespace(transcript=transcript)
    deps = ReindexTranscriptDependencies(load=Mock(return_value=video), index=Mock(), delete=Mock())
    execute_reindex_transcript(12, deps)
    if transcript and transcript.strip():
        deps.index.assert_called_once_with(video)
        deps.delete.assert_not_called()
    else:
        deps.delete.assert_called_once_with(12)
        deps.index.assert_not_called()


def test_deleted_video_does_not_touch_provider_or_index():
    deps = ReindexTranscriptDependencies(load=Mock(return_value=None), index=Mock(), delete=Mock())
    execute_reindex_transcript(12, deps)
    deps.index.assert_not_called()
    deps.delete.assert_not_called()


def test_provider_failure_propagates_for_job_retry():
    failure = RuntimeError("provider failed")
    deps = ReindexTranscriptDependencies(load=Mock(return_value=SimpleNamespace(transcript="subtitle")), index=Mock(side_effect=failure), delete=Mock())
    with pytest.raises(RuntimeError) as result:
        execute_reindex_transcript(12, deps)
    assert result.value is failure
    deps.delete.assert_not_called()
