import json
from types import SimpleNamespace
from unittest.mock import MagicMock, call

import pytest

from worker_python.tasks import cloud_account_deletion, registry
from worker_python import lambda_handler


@pytest.fixture(autouse=True)
def cloud_environment(monkeypatch):
    monkeypatch.setenv("DEPLOYMENT_EDITION", "cloud")
    monkeypatch.delenv("PERSISTENCE_BACKEND", raising=False)
    monkeypatch.delenv("DATABASE_URL", raising=False)


def test_steps_heartbeat_and_complete_without_sql(monkeypatch):
    api = MagicMock(side_effect=[{"updated": True}, {"status": "progress"}, {"updated": True}, {"status": "completed"}])
    monkeypatch.setattr(cloud_account_deletion, "call_internal_api", api)
    cloud_account_deletion.delete_account_data("owner", job_id="job", lease_token="lease")
    identity = {"jobId": "job", "leaseToken": "lease"}
    assert api.call_args_list == [call("heartbeat", identity), call("account-delete/step", {**identity, "userId": "owner"})] * 2


@pytest.mark.parametrize("response", [{}, {"status": "denied"}, {"status": "invalid"}])
def test_invalid_or_revoked_steps_never_complete(monkeypatch, response):
    api = MagicMock(side_effect=[{"updated": True}, response])
    monkeypatch.setattr(cloud_account_deletion, "call_internal_api", api)
    with pytest.raises(RuntimeError, match="authorization"):
        cloud_account_deletion.delete_account_data("owner", job_id="job", lease_token="lease")


def test_lost_lease_prevents_any_deletion_step(monkeypatch):
    api = MagicMock(return_value={"updated": False})
    monkeypatch.setattr(cloud_account_deletion, "call_internal_api", api)
    with pytest.raises(RuntimeError, match="lease"):
        cloud_account_deletion.delete_account_data("owner", job_id="job", lease_token="lease")
    api.assert_called_once_with("heartbeat", {"jobId": "job", "leaseToken": "lease"})


def test_step_budget_is_retryable_and_does_not_claim_completion(monkeypatch):
    api = MagicMock(side_effect=lambda action, payload: {"updated": True} if action == "heartbeat" else {"status": "progress"})
    monkeypatch.setattr(cloud_account_deletion, "call_internal_api", api)
    with pytest.raises(RuntimeError, match="budget"):
        cloud_account_deletion.delete_account_data("owner", job_id="job", lease_token="lease")
    assert api.call_count == 1000


def test_cloud_registry_lazily_selects_only_the_cloud_task(monkeypatch):
    function = MagicMock()
    importer = MagicMock(return_value=SimpleNamespace(delete_account_data=function))
    monkeypatch.setattr(registry, "import_module", importer)
    assert registry.get_task("delete_account_data") is function
    importer.assert_called_once_with("worker_python.tasks.cloud_account_deletion")


def test_onprem_registry_keeps_postgres_implementation(monkeypatch):
    monkeypatch.setenv("DEPLOYMENT_EDITION", "onprem")
    function = MagicMock()
    importer = MagicMock(return_value=SimpleNamespace(delete_account_data=function))
    monkeypatch.setattr(registry, "import_module", importer)
    assert registry.get_task("delete_account_data") is function
    importer.assert_called_once_with("worker_python.tasks.account_deletion")


def test_dispatch_passes_the_claimed_identity_and_completes_only_after_task_returns(monkeypatch):
    task = MagicMock()
    monkeypatch.setattr(lambda_handler, "claim_job_execution", MagicMock(return_value="lease"))
    monkeypatch.setattr(lambda_handler, "get_task", MagicMock(return_value=task))
    completed = MagicMock()
    monkeypatch.setattr(lambda_handler, "complete_job_execution", completed)
    lambda_handler._execute_task(json.dumps({"type": "delete_account_data", "job_id": "job", "payload": {"user_id": "owner"}}))
    task.assert_called_once_with(user_id="owner", job_id="job", lease_token="lease")
    completed.assert_called_once_with("job", "lease")
