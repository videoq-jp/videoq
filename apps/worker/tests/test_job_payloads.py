import json
from inspect import signature
from unittest.mock import MagicMock

import pytest

from worker_python import lambda_handler, sqs_enqueue
from worker_python.contracts import (
    JOB_DELETE_ACCOUNT_DATA,
    JOB_INDEX_VIDEO_TRANSCRIPT,
    JOB_REINDEX_ALL_VIDEOS_EMBEDDINGS,
    JOB_REINDEX_VIDEO_TRANSCRIPT,
    JOB_TRANSCRIBE_VIDEO,
    JOB_TRANSCRIBE_VIDEO_CHUNK,
    JOB_FINISH_VIDEO_TRANSCRIPTION,
    JOB_BUILD_VIDEO_VISUALS,
)
from worker_python.tasks.registry import get_task


@pytest.fixture
def execution(monkeypatch):
    claim = MagicMock(return_value="lease")
    task = MagicMock()
    complete = MagicMock()
    monkeypatch.setattr(lambda_handler, "claim_job_execution", claim)
    monkeypatch.setattr(lambda_handler, "get_task", lambda _: task)
    monkeypatch.setattr(lambda_handler, "complete_job_execution", complete)
    monkeypatch.setattr(lambda_handler, "fail_job_execution", MagicMock())
    monkeypatch.setattr(lambda_handler, "ensure_secrets_loaded", lambda: None)
    return claim, task, complete


def message(job_type, payload):
    return json.dumps({"type": job_type, "job_id": "job", "payload": payload})


@pytest.mark.parametrize("job_type, payload", [
    (JOB_TRANSCRIBE_VIDEO, {"video_id": 1}),
    (JOB_INDEX_VIDEO_TRANSCRIPT, {"video_id": 2**53 - 1}),
    (JOB_REINDEX_VIDEO_TRANSCRIPT, {"video_id": 42}),
    (JOB_DELETE_ACCOUNT_DATA, {"user_id": "user-42"}),
    (JOB_REINDEX_ALL_VIDEOS_EMBEDDINGS, {}),
    (JOB_REINDEX_ALL_VIDEOS_EMBEDDINGS, {"after_id": 25, "root_job_id": "root-job"}),
    (JOB_TRANSCRIBE_VIDEO_CHUNK, {"video_id": 42, "run_id": "12345678-1234-4234-8234-123456789abc", "chunk_index": 30}),
    (JOB_FINISH_VIDEO_TRANSCRIPTION, {"video_id": 42, "run_id": "12345678-1234-4234-8234-123456789abc"}),
    (JOB_BUILD_VIDEO_VISUALS, {"video_id": 42, "run_id": "12345678-1234-4234-8234-123456789abc", "cache_kind": "coarse"}),
])
def test_all_job_types_preserve_arguments_from_producer_to_task(execution, job_type, payload):
    claim, task, complete = execution
    envelope = sqs_enqueue.build_job_message(job_type, payload, job_id="job")
    lambda_handler._execute_task(json.dumps(envelope))
    expected = {**payload, **({"job_id": "job"} if job_type in {JOB_TRANSCRIBE_VIDEO, JOB_REINDEX_ALL_VIDEOS_EMBEDDINGS} else {})}
    task.assert_called_once_with(**expected)
    # Check the real callable's interface without running providers or deleting data.
    signature(get_task(job_type)).bind(*task.call_args.args, **task.call_args.kwargs)
    claim.assert_called_once_with("job", job_type, payload)
    complete.assert_called_once_with("job", "lease")


@pytest.mark.parametrize("job_type, field", [
    (JOB_TRANSCRIBE_VIDEO, "video_id"),
    (JOB_INDEX_VIDEO_TRANSCRIPT, "video_id"),
    (JOB_REINDEX_VIDEO_TRANSCRIPT, "video_id"),
])
@pytest.mark.parametrize("value", [True, False, 1.9, "1", 0, -1, 2**53, None])
def test_invalid_resource_ids_never_claim_or_run_a_job(execution, job_type, field, value):
    claim, task, complete = execution
    with pytest.raises((TypeError, ValueError)):
        lambda_handler._execute_task(message(job_type, {field: value}))
    claim.assert_not_called()
    task.assert_not_called()
    complete.assert_not_called()


@pytest.mark.parametrize("value", [True, 42, None, "", "  ", {}])
def test_account_deletion_never_coerces_a_user_id(execution, value):
    claim, task, complete = execution
    with pytest.raises((TypeError, ValueError)):
        lambda_handler._execute_task(message(JOB_DELETE_ACCOUNT_DATA, {"user_id": value}))
    claim.assert_not_called()
    task.assert_not_called()
    complete.assert_not_called()


@pytest.mark.parametrize("job_type, payload", [
    (JOB_TRANSCRIBE_VIDEO, {}),
    (JOB_INDEX_VIDEO_TRANSCRIPT, {"video_id": 1, "unexpected": True}),
    (JOB_REINDEX_ALL_VIDEOS_EMBEDDINGS, {"video_id": 1}),
    ("unknown_job", {}),
])
def test_incorrect_payload_shapes_fail_before_claiming(execution, job_type, payload):
    claim, task, complete = execution
    with pytest.raises((TypeError, ValueError)):
        lambda_handler._execute_task(message(job_type, payload))
    claim.assert_not_called()
    task.assert_not_called()
    complete.assert_not_called()


@pytest.mark.parametrize("body", [[], None, 1, "message"])
def test_non_object_envelopes_fail_before_claiming(execution, body):
    claim, task, _ = execution
    with pytest.raises(ValueError, match="object"):
        lambda_handler._execute_task(json.dumps(body))
    claim.assert_not_called()
    task.assert_not_called()


def test_invalid_batch_item_does_not_stop_a_valid_job(execution):
    claim, task, complete = execution
    result = lambda_handler.handler({"Records": [
        {"messageId": "bad", "body": message(JOB_TRANSCRIBE_VIDEO, {"video_id": 1.9})},
        {"messageId": "good", "body": message(JOB_INDEX_VIDEO_TRANSCRIPT, {"video_id": 42})},
    ]}, None)
    assert result == {"batchItemFailures": [{"itemIdentifier": "bad"}]}
    claim.assert_called_once_with("job", JOB_INDEX_VIDEO_TRANSCRIPT, {"video_id": 42})
    assert task.call_count == 1
    complete.assert_called_once_with("job", "lease")


@pytest.mark.parametrize("field,value", [
    ("run_id", None), ("run_id", "not-a-run"), ("run_id", "12345678123442348234123456789abc"),
    ("chunk_index", -1), ("chunk_index", 10000), ("chunk_index", True), ("chunk_index", "0"),
    ("video_id", True),
])
def test_invalid_checkpoint_payload_does_not_claim_work(execution, field, value):
    claim, task, _ = execution
    payload = {"video_id": 42, "run_id": "12345678-1234-4234-8234-123456789abc", "chunk_index": 0}
    payload[field] = value
    with pytest.raises((TypeError, ValueError)):
        lambda_handler._execute_task(message(JOB_TRANSCRIBE_VIDEO_CHUNK, payload))
    claim.assert_not_called()
    task.assert_not_called()


@pytest.mark.parametrize("job_type, payload", [
    (JOB_INDEX_VIDEO_TRANSCRIPT, {"video_id": True}),
    (JOB_TRANSCRIBE_VIDEO, {"video_id": 1.9}),
    (JOB_DELETE_ACCOUNT_DATA, {"user_id": 42}),
    (JOB_REINDEX_ALL_VIDEOS_EMBEDDINGS, {"video_id": 1}),
    (JOB_REINDEX_ALL_VIDEOS_EMBEDDINGS, []),
    (JOB_REINDEX_ALL_VIDEOS_EMBEDDINGS, False),
    ("unknown_job", {}),
])
def test_producer_rejects_invalid_work_before_creating_an_sqs_client(monkeypatch, job_type, payload):
    monkeypatch.setenv("SQS_QUEUE_URL", "https://example.invalid/jobs")
    create = MagicMock()
    monkeypatch.setattr(sqs_enqueue, "create_sqs_client", create)
    with pytest.raises((TypeError, ValueError)):
        sqs_enqueue.enqueue_job(job_type, payload)
    create.assert_not_called()
