from contextlib import contextmanager
from unittest.mock import MagicMock

import pytest

from worker_python.contracts import validate_job_payload
from worker_python.tasks import reindexing
from worker_python.pipeline.embedding_contract import EmbeddingContractError


@pytest.fixture
def dispatcher(monkeypatch):
    monkeypatch.setenv('SQS_SEARCH_QUEUE_URL', 'https://queue/search')
    conn = MagicMock()

    @contextmanager
    def db():
        yield conn

    send = MagicMock(return_value='message')
    monkeypatch.setattr(reindexing, 'db_connection', db)
    monkeypatch.setattr(reindexing, 'enqueue_job', send)
    monkeypatch.setattr(reindexing.vector_index, 'check_embedding_storage', MagicMock())
    monkeypatch.setattr(reindexing.vector_index, 'index_video_transcript', MagicMock(side_effect=AssertionError('must not embed in dispatcher')))
    return conn, send


@pytest.mark.parametrize('size', [0, 1, 25, 26])
def test_bounded_dispatch_and_continuation(dispatcher, size):
    conn, send = dispatcher
    conn.execute.return_value.fetchall.return_value = [{'id': i} for i in range(101, 101 + size)]
    reindexing.reindex_all_videos_embeddings(after_id=100, job_id='parent')
    query, args = conn.execute.call_args.args
    assert args == (100, 26)
    assert 'SELECT id' in query and 'LIMIT' in query
    assert send.call_count == min(size, 25) + (size > 25)
    for call in send.call_args_list[:min(size, 25)]:
        assert call.args[0] == 'reindex_video_transcript'
    if size > 25:
        assert send.call_args.args == ('reindex_all_videos_embeddings', {'after_id': 125, 'root_job_id': 'parent'})


def test_partial_dispatch_retries_with_identical_child_ids(dispatcher):
    conn, send = dispatcher
    conn.execute.return_value.fetchall.return_value = [{'id': 1}, {'id': 2}]
    send.side_effect = ['message', RuntimeError('SQS unavailable')]
    with pytest.raises(RuntimeError, match='SQS unavailable'):
        reindexing.reindex_all_videos_embeddings(job_id='parent')
    first_attempt = send.call_args_list[:]
    send.reset_mock(side_effect=True)
    send.return_value = 'message'
    reindexing.reindex_all_videos_embeddings(job_id='parent')
    assert send.call_args_list == first_attempt


def test_video_identity_survives_page_boundary_changes(dispatcher):
    conn, send = dispatcher
    conn.execute.return_value.fetchall.return_value = [{'id': 26}]
    reindexing.reindex_all_videos_embeddings(job_id='initial-job')
    original = send.call_args
    send.reset_mock()
    # Deletions/status changes can shift the same video onto a different page.
    reindexing.reindex_all_videos_embeddings(
        after_id=25, root_job_id='initial-job', job_id='continuation-job',
    )
    assert send.call_args == original


def test_missing_send_confirmation_keeps_parent_retryable(dispatcher):
    conn, send = dispatcher
    conn.execute.return_value.fetchall.return_value = [{'id': 1}]
    send.return_value = None
    with pytest.raises(RuntimeError, match='Failed to enqueue'):
        reindexing.reindex_all_videos_embeddings(job_id='parent')


@pytest.mark.parametrize('cursor', [-1, True, '1', 1.2, 2**53, None])
def test_invalid_cursor_rejected(cursor):
    with pytest.raises(ValueError):
        validate_job_payload('reindex_all_videos_embeddings', {'after_id': cursor})


def test_queued_dispatch_requires_stable_identity(dispatcher):
    with pytest.raises(ValueError, match='stable parent'):
        reindexing.reindex_all_videos_embeddings()


@pytest.mark.parametrize('after_id', [0, 25])
def test_schema_failure_prevents_children_and_continuation_then_allows_retry(dispatcher, after_id):
    conn, send = dispatcher
    conn.execute.return_value.fetchall.return_value = [{'id': after_id + i} for i in range(1, 27)]
    check = reindexing.vector_index.check_embedding_storage
    check.side_effect = EmbeddingContractError('EMBEDDING_SCHEMA_MISMATCH', 'schema mismatch')
    with pytest.raises(EmbeddingContractError, match='schema mismatch'):
        reindexing.reindex_all_videos_embeddings(after_id=after_id, job_id='parent')
    send.assert_not_called()
    check.side_effect = None
    reindexing.reindex_all_videos_embeddings(after_id=after_id, job_id='parent')
    assert send.call_count == 26


def test_schema_is_checked_before_first_send(dispatcher):
    conn, send = dispatcher
    conn.execute.return_value.fetchall.return_value = [{'id': 1}]
    check = reindexing.vector_index.check_embedding_storage
    send.side_effect = lambda *args, **kwargs: check.assert_called_once_with() or 'sent'
    reindexing.reindex_all_videos_embeddings(job_id='parent')
    send.assert_called_once()


def test_empty_page_does_not_require_embedding_storage(dispatcher):
    conn, send = dispatcher
    conn.execute.return_value.fetchall.return_value = []
    reindexing.reindex_all_videos_embeddings(job_id='parent')
    reindexing.vector_index.check_embedding_storage.assert_not_called()
    send.assert_not_called()


@pytest.mark.parametrize('root', ['', ' ', True, None, 'x' * 129])
def test_invalid_root_identity_rejected(root):
    with pytest.raises(ValueError):
        validate_job_payload('reindex_all_videos_embeddings', {'after_id': 25, 'root_job_id': root})
