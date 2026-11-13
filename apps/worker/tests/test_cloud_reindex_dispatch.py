from unittest.mock import MagicMock
import pytest
from worker_python.tasks import reindexing

@pytest.fixture
def setup(monkeypatch):
    monkeypatch.setenv('PERSISTENCE_BACKEND','d1')
    monkeypatch.setenv('SQS_SEARCH_QUEUE_URL','https://queue/search')
    monkeypatch.setattr(reindexing,'db_connection',MagicMock(side_effect=AssertionError('PostgreSQL')))
    monkeypatch.setattr(reindexing,'full_vector_write_lock',MagicMock(side_effect=AssertionError('PostgreSQL lock')))
    monkeypatch.setattr(reindexing.vector_index,'check_embedding_storage',MagicMock(side_effect=AssertionError('pgvector')))
    api=MagicMock(return_value={'ids':list(range(1,27))})
    send=MagicMock(return_value='message')
    monkeypatch.setattr(reindexing,'call_internal_api',api)
    monkeypatch.setattr(reindexing,'enqueue_job',send)
    return api,send


def test_cloud_dispatch_uses_only_bounded_ids_and_stable_continuation(setup):
    api,send=setup
    reindexing.reindex_all_videos_embeddings(job_id='root')
    assert api.call_args.args[0]=='reindex/page'
    assert api.call_args.args[1]['afterId']==0
    assert send.call_count==26
    assert send.call_args.args==('reindex_all_videos_embeddings',{'after_id':25,'root_job_id':'root'})
    ids=[call.kwargs['job_id'] for call in send.call_args_list]
    send.reset_mock()
    reindexing.reindex_all_videos_embeddings(job_id='root')
    assert [call.kwargs['job_id'] for call in send.call_args_list]==ids


def test_cloud_failure_prevents_fanout_and_missing_queue_never_uses_pg(setup,monkeypatch):
    api,send=setup
    api.side_effect=RuntimeError('API unavailable')
    with pytest.raises(RuntimeError):
        reindexing.reindex_all_videos_embeddings(job_id='root')
    send.assert_not_called()
    monkeypatch.delenv('SQS_SEARCH_QUEUE_URL')
    monkeypatch.delenv('SQS_QUEUE_URL',raising=False)
    with pytest.raises(RuntimeError,match='search queue'):
        reindexing.reindex_all_videos_embeddings(job_id='root')


@pytest.mark.parametrize('ids',[[2,1],[1,1],[0],[True],list(range(1,28)),['1']])
def test_invalid_page_never_emits_children(setup,ids):
    api,send=setup
    api.return_value={'ids':ids}
    with pytest.raises(RuntimeError,match='page response'):
        reindexing.reindex_all_videos_embeddings(job_id='root')
    send.assert_not_called()
