"""Exercise lifecycle decisions without database or provider modules."""
from types import SimpleNamespace
from unittest.mock import Mock

import pytest

from worker_python.use_cases.indexing import (
    IndexingDependencies, IndexingExecutionFailedError, execute_indexing,
)


def dependencies(video, *, updated=True, current=None):
    return IndexingDependencies(
        load=Mock(return_value=video), index=Mock(), clear=Mock(),
        finish=Mock(return_value=(updated, current)),
    )


@pytest.mark.parametrize("video", [None, SimpleNamespace(status="completed")])
def test_missing_or_completed_video_has_no_side_effects(video):
    deps = dependencies(video)
    execute_indexing(42, deps)
    deps.index.assert_not_called()
    deps.clear.assert_not_called()
    deps.finish.assert_not_called()


def test_provider_failure_does_not_complete_video():
    deps = dependencies(SimpleNamespace(status="indexing", transcript="text"))
    deps.index.side_effect = RuntimeError("provider failed")
    with pytest.raises(IndexingExecutionFailedError):
        execute_indexing(42, deps)
    deps.finish.assert_not_called()


def test_changed_snapshot_requires_retry():
    video = SimpleNamespace(status="indexing", transcript="old")
    deps = dependencies(video, updated=False, current=SimpleNamespace(status="indexing"))
    with pytest.raises(IndexingExecutionFailedError, match="Transcript changed"):
        execute_indexing(42, deps)
    deps.index.assert_called_once_with(video)


@pytest.mark.parametrize("allow_empty,cleared", [(True, True), (False, False), (1, False)])
def test_only_explicit_clear_bypasses_indexing(allow_empty, cleared):
    video = SimpleNamespace(status="indexing", transcript=" \n")
    deps = dependencies(video)
    execute_indexing(42, deps, allow_empty=allow_empty)
    assert deps.clear.called is cleared
    assert deps.index.called is not cleared
    deps.finish.assert_called_once_with(video)
