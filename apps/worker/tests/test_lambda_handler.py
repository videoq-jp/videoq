"""Decode-only tests (no DATABASE_URL required)."""

from __future__ import annotations

import base64
import json
import logging
from contextlib import nullcontext
from unittest.mock import MagicMock, patch

import pytest

from worker_python.contracts import JOB_DELETE_ACCOUNT_DATA, JOB_INDEX_VIDEO_TRANSCRIPT, JOB_TRANSCRIBE_VIDEO
from worker_python.lambda_handler import _execute_task
from worker_python.lambda_handler import handler
from worker_python.tasks import transcription


def test_failed_task_diagnostics_do_not_reach_logs_or_delivery_records(caplog) -> None:
    canary = "synthetic-private-provider-token-and-SQL-parameters"
    body = json.dumps({"type": JOB_TRANSCRIBE_VIDEO, "job_id": "redaction-failure", "payload": {"video_id": 42}})
    with (
        patch("worker_python.lambda_handler.ensure_secrets_loaded"),
        patch("worker_python.lambda_handler.claim_job_execution", return_value="lease"),
        patch("worker_python.lambda_handler.get_task") as task,
        patch("worker_python.lambda_handler.fail_job_execution") as fail,
        caplog.at_level(logging.INFO, logger="worker_python.lambda_handler"),
    ):
        task.return_value.side_effect = RuntimeError(canary)
        result = handler({"Records": [{"messageId": "message-1", "body": body}]}, None)
    assert result == {"batchItemFailures": [{"itemIdentifier": "message-1"}]}
    fail.assert_called_once_with("redaction-failure", "lease", "WORKER_EXECUTION_FAILED")
    assert canary not in caplog.text
    assert all(record.exc_info is None for record in caplog.records)


def test_bookkeeping_failures_are_redacted_and_other_deliveries_still_run(caplog) -> None:
    canary = "synthetic-private-failure-record-SQL-token"
    body = json.dumps({"type": JOB_INDEX_VIDEO_TRANSCRIPT, "job_id": "record-failure", "payload": {"video_id": 42}})
    with (
        patch("worker_python.lambda_handler.ensure_secrets_loaded"),
        patch("worker_python.lambda_handler.claim_job_execution", side_effect=["lease", None]),
        patch("worker_python.lambda_handler.get_task") as task,
        patch("worker_python.lambda_handler.fail_job_execution", side_effect=RuntimeError(canary)),
        caplog.at_level(logging.INFO, logger="worker_python.lambda_handler"),
    ):
        task.return_value.side_effect = RuntimeError(canary)
        result = handler({"Records": [{"messageId": "failed", "body": body}, {"messageId": "duplicate", "body": body}]}, None)
    assert result == {"batchItemFailures": [{"itemIdentifier": "failed"}]}
    assert canary not in caplog.text
    assert all(record.exc_info is None for record in caplog.records)


def test_dispatch_logs_do_not_copy_job_payload(caplog) -> None:
    canary = "synthetic-private-account-owner"
    body = json.dumps({"type": JOB_DELETE_ACCOUNT_DATA, "job_id": "dispatch-redaction", "payload": {"user_id": canary}})
    with (
        patch("worker_python.lambda_handler.claim_job_execution", return_value=None),
        caplog.at_level(logging.INFO, logger="worker_python.lambda_handler"),
    ):
        _execute_task(body)
    assert "Dispatching task" in caplog.text
    assert canary not in caplog.text


@pytest.mark.parametrize("origin,secret", [("", "a" * 40), ("http://api.example.test", "a" * 40), ("https://api.example.test", "short")])
def test_invalid_cloud_configuration_fails_before_accepting_even_an_empty_batch(monkeypatch, origin, secret) -> None:
    monkeypatch.setenv("DEPLOYMENT_EDITION", "cloud")
    monkeypatch.delenv("PERSISTENCE_BACKEND", raising=False)
    monkeypatch.setenv("WORKER_INTERNAL_API_ORIGIN", origin)
    monkeypatch.setenv("WORKER_INTERNAL_API_SECRET", secret)
    with (
        patch("worker_python.lambda_handler.ensure_secrets_loaded"),
        patch("worker_python.lambda_handler.claim_job_execution") as claim,
    ):
        with pytest.raises(RuntimeError):
            handler({"Records": []}, None)
    claim.assert_not_called()


@pytest.mark.parametrize("job_type", [JOB_TRANSCRIBE_VIDEO, JOB_INDEX_VIDEO_TRANSCRIPT])
def test_execute_task_decodes_native_message(job_type) -> None:
    body = json.dumps(
        {
            "type": job_type,
            "job_id": "job-1",
            "payload": {"video_id": 42},
        }
    )
    with (
        patch(
            "worker_python.lambda_handler.claim_job_execution",
            return_value="lease-1",
        ),
        patch("worker_python.lambda_handler.complete_job_execution") as complete,
        patch("worker_python.lambda_handler.get_task") as get_task,
    ):
        fn = get_task.return_value
        _execute_task(body)
        get_task.assert_called_once_with(job_type)
        if job_type == JOB_TRANSCRIBE_VIDEO:
            fn.assert_called_once_with(video_id=42, job_id="job-1")
        else:
            fn.assert_called_once_with(video_id=42)
        complete.assert_called_once_with("job-1", "lease-1")


@pytest.mark.parametrize("allow_empty", [True, False])
def test_execute_task_passes_explicit_clear_intent_through_native_delivery(allow_empty):
    message = {"type": JOB_INDEX_VIDEO_TRANSCRIPT, "job_id": "manual-clear",
               "payload": {"video_id": 42, "allow_empty": allow_empty}}
    with (
        patch("worker_python.lambda_handler.claim_job_execution", return_value="clear-lease") as claim,
        patch("worker_python.lambda_handler.complete_job_execution") as complete,
        patch("worker_python.lambda_handler.get_task") as get_task,
    ):
        _execute_task(json.dumps(message))
        claim.assert_called_once_with("manual-clear", JOB_INDEX_VIDEO_TRANSCRIPT, message["payload"])
        get_task.return_value.assert_called_once_with(video_id=42, allow_empty=allow_empty)
        complete.assert_called_once_with("manual-clear", "clear-lease")


@pytest.mark.parametrize("allow_empty", [None, "true", 1, 0, [], {}])
def test_explicit_clear_rejects_coerced_flags_before_claiming_work(allow_empty):
    message = {"type": JOB_INDEX_VIDEO_TRANSCRIPT, "job_id": "invalid-clear",
               "payload": {"video_id": 42, "allow_empty": allow_empty}}
    with patch("worker_python.lambda_handler.claim_job_execution") as claim:
        with pytest.raises(ValueError, match="allow_empty must be a boolean"):
            _execute_task(json.dumps(message))
        claim.assert_not_called()


def test_explicit_clear_flag_is_not_accepted_for_transcription():
    message = {"type": JOB_TRANSCRIBE_VIDEO, "job_id": "invalid-clear",
               "payload": {"video_id": 42, "allow_empty": True}}
    with patch("worker_python.lambda_handler.claim_job_execution") as claim:
        with pytest.raises(TypeError, match="exactly"):
            _execute_task(json.dumps(message))
        claim.assert_not_called()


def test_execute_task_decodes_outer_base64() -> None:
    payload = {
        "type": JOB_TRANSCRIBE_VIDEO,
        "job_id": "job-2",
        "payload": {"video_id": 7},
    }
    outer = base64.b64encode(json.dumps(payload).encode()).decode()
    with (
        patch(
            "worker_python.lambda_handler.claim_job_execution",
            return_value="lease-2",
        ),
        patch("worker_python.lambda_handler.complete_job_execution"),
        patch("worker_python.lambda_handler.get_task") as get_task,
    ):
        fn = get_task.return_value
        _execute_task(outer)
        fn.assert_called_once_with(video_id=7, job_id="job-2")


def test_execute_task_passes_uuid_user_id_for_account_deletion() -> None:
    user_id = "00000000-0000-4000-8000-000000000009"
    body = json.dumps(
        {
            "type": JOB_DELETE_ACCOUNT_DATA,
            "job_id": "job-del",
            "payload": {"user_id": user_id},
        }
    )
    with (
        patch(
            "worker_python.lambda_handler.claim_job_execution",
            return_value="lease-del",
        ),
        patch("worker_python.lambda_handler.complete_job_execution"),
        patch("worker_python.lambda_handler.get_task") as get_task,
    ):
        fn = get_task.return_value
        _execute_task(body)
        get_task.assert_called_once_with(JOB_DELETE_ACCOUNT_DATA)
        fn.assert_called_once_with(user_id=user_id)


def test_execute_task_skips_completed_duplicate_job_id() -> None:
    body = json.dumps(
        {
            "type": JOB_TRANSCRIBE_VIDEO,
            "job_id": "job-duplicate",
            "payload": {"video_id": 42},
        }
    )
    with (
        patch("worker_python.lambda_handler.claim_job_execution", return_value=None),
        patch("worker_python.lambda_handler.get_task") as get_task,
    ):
        _execute_task(body)

    get_task.assert_not_called()


@pytest.mark.parametrize("job_type, task", [(JOB_TRANSCRIBE_VIDEO, transcription)])
def test_deleted_video_delivery_completes_without_retry_or_provider_work(monkeypatch, job_type, task):
    monkeypatch.setattr(task, "db_connection", lambda: nullcontext(MagicMock()))
    monkeypatch.setattr(task, "get_video_for_task", MagicMock(return_value=None))
    transcribe = MagicMock()
    embed = MagicMock()
    enqueue = MagicMock()
    monkeypatch.setattr(transcription, "run_transcription", transcribe)
    monkeypatch.setattr(transcription, "enqueue_job", enqueue)
    body = json.dumps({"type": job_type, "job_id": "deleted-video-job", "payload": {"video_id": 42}})
    with (
        patch("worker_python.lambda_handler.claim_job_execution", return_value="lease-deleted"),
        patch("worker_python.lambda_handler.complete_job_execution") as complete,
        patch("worker_python.lambda_handler.fail_job_execution") as fail,
    ):
        _execute_task(body)
    complete.assert_called_once_with("deleted-video-job", "lease-deleted")
    fail.assert_not_called()
    transcribe.assert_not_called()
    embed.assert_not_called()
    enqueue.assert_not_called()


def test_execute_task_releases_lease_for_sqs_retry_on_failure() -> None:
    body = json.dumps(
        {
            "type": JOB_TRANSCRIBE_VIDEO,
            "job_id": "job-failed",
            "payload": {"video_id": 42},
        }
    )
    with (
        patch(
            "worker_python.lambda_handler.claim_job_execution",
            return_value="lease-failed",
        ),
        patch("worker_python.lambda_handler.fail_job_execution") as fail,
        patch("worker_python.lambda_handler.get_task") as get_task,
    ):
        get_task.return_value = MagicMock(side_effect=RuntimeError("boom"))
        with pytest.raises(RuntimeError, match="boom"):
            _execute_task(body)

    fail.assert_called_once_with("job-failed", "lease-failed", "WORKER_EXECUTION_FAILED")


@pytest.mark.parametrize(
    "message, expected",
    [
        ({"type": "", "job_id": "job-1", "payload": {}}, "type"),
        ({"type": "x" * 65, "job_id": "job-1", "payload": {}}, "type"),
        ({"type": JOB_TRANSCRIBE_VIDEO, "job_id": "job-1", "payload": []}, "payload"),
    ],
)
def test_execute_task_validates_job_envelope(message: dict, expected: str) -> None:
    with pytest.raises(ValueError, match=expected):
        _execute_task(json.dumps(message))


@pytest.mark.parametrize("job_type", ["build_plog", "evaluate_chat_log"])
@pytest.mark.parametrize("encoded", [False, True])
def test_retired_job_is_acknowledged_without_accessing_storage(encoded: bool, job_type: str) -> None:
    body = json.dumps({"type": job_type, "job_id": "retired-1", "payload": {"video_id": 42}})
    if encoded:
        body = base64.b64encode(body.encode()).decode()
    with (
        patch("worker_python.lambda_handler.claim_job_execution") as claim,
        patch("worker_python.lambda_handler.get_task") as get_task,
    ):
        _execute_task(body)
    claim.assert_not_called()
    get_task.assert_not_called()
