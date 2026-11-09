import json
from unittest.mock import MagicMock

import pytest

from worker_python import lambda_handler, sqs_enqueue
from worker_python.contracts import _PAYLOAD_FIELDS
from worker_python.job_routing import job_group, queue_url_for_job


@pytest.mark.parametrize('kind', list(_PAYLOAD_FIELDS))
def test_all_jobs_route_to_their_group_with_legacy_fallback(monkeypatch, kind):
    for group in ('MEDIA', 'SEARCH', 'ACCOUNT'):
        monkeypatch.setenv(f'SQS_{group}_QUEUE_URL', f'https://queue/{group.lower()}')
    monkeypatch.setenv('SQS_QUEUE_URL', 'https://queue/legacy')
    expected = ('account' if kind == 'delete_account_data' else
                'search' if kind in {'index_video_transcript', 'reindex_video_transcript', 'reindex_all_videos_embeddings'} else 'media')
    assert job_group(kind) == expected
    assert queue_url_for_job(kind) == f'https://queue/{expected}'
    monkeypatch.setenv(f'SQS_{expected.upper()}_QUEUE_URL', ' ')
    assert queue_url_for_job(kind) == 'https://queue/legacy'


def test_child_job_uses_search_queue_even_when_received_from_media(monkeypatch):
    monkeypatch.setenv('SQS_QUEUE_URL', 'https://queue/media')
    monkeypatch.setenv('SQS_SEARCH_QUEUE_URL', 'https://queue/search')
    client = MagicMock()
    client.send_message.return_value = {'MessageId': 'sent'}
    monkeypatch.setattr(sqs_enqueue, 'create_sqs_client', lambda: client)
    assert sqs_enqueue.enqueue_job('index_video_transcript', {'video_id': 42}) == 'sent'
    assert client.send_message.call_args.kwargs['QueueUrl'] == 'https://queue/search'
    client.close.assert_called_once()


def test_misrouted_job_fails_before_claim_or_execution(monkeypatch):
    monkeypatch.setenv('WORKER_JOB_GROUP', 'account')
    claim = MagicMock()
    monkeypatch.setattr(lambda_handler, 'claim_job_execution', claim)
    with pytest.raises(ValueError, match='does not belong'):
        lambda_handler._execute_task(json.dumps({
            'type': 'index_video_transcript', 'job_id': 'wrong-queue', 'payload': {'video_id': 1},
        }))
    claim.assert_not_called()
