from types import SimpleNamespace
from unittest.mock import Mock

import pytest

from worker_python.use_cases.reindex_batch import (
    FullReindexDependencies, ReindexBatchDependencies, ReindexingIncompleteError,
    dispatch_reindex_page, execute_full_reindex, execute_reindex_batch,
)


def test_empty_iterator_needs_no_storage_or_provider():
    deps = ReindexBatchDependencies(prepare=Mock(), index=Mock())
    execute_reindex_batch(iter([]), deps)
    deps.prepare.assert_not_called()
    deps.index.assert_not_called()


def test_batch_continues_after_failure_and_requires_retry():
    videos = [SimpleNamespace(id=i, title=str(i)) for i in range(3)]
    deps = ReindexBatchDependencies(prepare=Mock(), index=Mock(side_effect=[None, RuntimeError(), None]))
    with pytest.raises(ReindexingIncompleteError, match="2/3 videos; 1 video"):
        execute_reindex_batch(iter(videos), deps)
    deps.prepare.assert_called_once()
    assert [call.args[0] for call in deps.index.call_args_list] == videos


def test_preflight_failure_never_replaces_a_video():
    failure = RuntimeError("incompatible storage")
    deps = ReindexBatchDependencies(prepare=Mock(side_effect=failure), index=Mock())
    with pytest.raises(RuntimeError) as result:
        execute_reindex_batch(iter([SimpleNamespace(id=1)]), deps)
    assert result.value is failure
    deps.index.assert_not_called()


def test_continuation_follows_all_children_and_is_omitted_on_partial_failure():
    events = []
    dispatch_reindex_page(list(range(1, 27)), send_video=lambda value: events.append(('video', value)), send_continuation=lambda cursor: events.append(('next', cursor)))
    assert events == [('video', i) for i in range(1, 26)] + [('next', 25)]
    continuation = Mock()
    with pytest.raises(RuntimeError):
        dispatch_reindex_page(list(range(1, 27)), send_video=Mock(side_effect=RuntimeError()), send_continuation=continuation)
    continuation.assert_not_called()


@pytest.mark.parametrize('cloud,queued,job_id,error', [
    (True, False, 'job', RuntimeError), (False, True, None, ValueError),
])
def test_full_rebuild_requires_supported_delivery_and_a_stable_parent(cloud, queued, job_id, error):
    deps = FullReindexDependencies(cloud, queued, Mock(), Mock())
    with pytest.raises(error):
        execute_full_reindex(deps, job_id=job_id, root_job_id='root')
    deps.dispatch_page.assert_not_called()
    deps.inline.assert_not_called()


def test_continuation_uses_original_root_identity_and_never_runs_inline():
    deps = FullReindexDependencies(True, True, Mock(), Mock())
    execute_full_reindex(deps, after_id=25, root_job_id='original', job_id='page-two')
    deps.dispatch_page.assert_called_once_with(25, 'original')
    deps.inline.assert_not_called()


def test_inline_rebuild_delegates_without_dispatching_a_page():
    deps = FullReindexDependencies(False, False, Mock(), Mock())
    execute_full_reindex(deps)
    deps.inline.assert_called_once_with()
    deps.dispatch_page.assert_not_called()
