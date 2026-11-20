from worker_python.sqs_enqueue import build_job_message, child_job_id


def test_build_job_message_shape() -> None:
    msg = build_job_message(
        "transcribe_video",
        {"video_id": 42},
        job_id="job-1",
    )
    assert msg["type"] == "transcribe_video"
    assert msg["job_id"] == "job-1"
    assert msg["payload"] == {"video_id": 42}


def test_child_job_id_is_stable_and_stage_scoped() -> None:
    first = child_job_id("parent-1", "index_video_transcript", {"video_id": 42})
    again = child_job_id("parent-1", "index_video_transcript", {"video_id": 42})
    another_stage = child_job_id("parent-1", "reindex_video_transcript", {"video_id": 42})

    assert first == again
    assert first != another_stage


def test_enqueue_does_not_log_payload_on_success_or_missing_queue(monkeypatch, caplog) -> None:
    import logging
    from unittest.mock import MagicMock
    from worker_python import sqs_enqueue

    canary = "synthetic-private-account-owner"
    payload = {"user_id": canary}
    client = MagicMock()
    client.send_message.return_value = {"MessageId": "synthetic-message"}
    monkeypatch.setattr(sqs_enqueue, "create_sqs_client", lambda: client)
    monkeypatch.setattr(sqs_enqueue, "queue_url_for_job", lambda _: "https://queue.example.test/owned")
    with caplog.at_level(logging.INFO, logger="worker_python.sqs_enqueue"):
        assert sqs_enqueue.enqueue_job("delete_account_data", payload) == "synthetic-message"
        monkeypatch.setattr(sqs_enqueue, "queue_url_for_job", lambda _: None)
        assert sqs_enqueue.enqueue_job("delete_account_data", payload) is None
    assert canary not in caplog.text
    assert "Enqueued" in caplog.text
    assert "skip enqueue" in caplog.text
    import json
    assert json.loads(client.send_message.call_args.kwargs["MessageBody"])["payload"] == payload
    client.send_message.assert_called_once()


def test_child_identity_preserves_pre_migration_durable_uuid_and_canonical_payload_order():
    from worker_python.domain.jobs import child_job_id as domain_child
    payload = {'video_id': 42, 'extra': {'b': '教材', 'a': 1}}
    assert domain_child('parent-1', 'transcribe_video_chunk', payload) == 'fd5f16ae-ecfb-546b-9712-230bfc52db16'
    assert child_job_id('parent-1', 'transcribe_video_chunk', {'extra': {'a': 1, 'b': '教材'}, 'video_id': 42}) == domain_child('parent-1', 'transcribe_video_chunk', payload)
    assert child_job_id('parent-1', 'transcribe_video', None) == child_job_id('parent-1', 'transcribe_video', {})


def test_domain_message_validates_before_allocating_identity_and_reuses_explicit_id():
    from unittest.mock import Mock
    import pytest
    from worker_python.domain.jobs import build_job_message as domain_message
    new_id = Mock(return_value='generated-id')
    with pytest.raises(ValueError):
        domain_message('transcribe_video', {'video_id': -1}, new_id=new_id)
    new_id.assert_not_called()
    payload = {'video_id': 42}
    assert domain_message('transcribe_video', payload, job_id='existing-id', new_id=new_id)['job_id'] == 'existing-id'
    new_id.assert_not_called()
    assert domain_message('transcribe_video', payload, new_id=new_id) == {'type': 'transcribe_video', 'payload': payload, 'job_id': 'generated-id'}
    new_id.assert_called_once()
