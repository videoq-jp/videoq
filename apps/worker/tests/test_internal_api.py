import hashlib
import hmac
import json
from unittest.mock import MagicMock

import pytest

from worker_python import internal_api, job_execution


@pytest.fixture(autouse=True)
def isolated_env(monkeypatch):
    for key in ("PERSISTENCE_BACKEND", "DEPLOYMENT_EDITION", "MIGRATION_ALLOW_CLOUD_POSTGRES",
                "WORKER_INTERNAL_API_ORIGIN", "WORKER_INTERNAL_API_SECRET"):
        monkeypatch.delenv(key, raising=False)


def test_backend_selection_is_explicit_and_no_fallback(monkeypatch):
    assert not internal_api.uses_internal_persistence()
    monkeypatch.setenv("DEPLOYMENT_EDITION", "cloud")
    assert internal_api.uses_internal_persistence()
    monkeypatch.setenv("PERSISTENCE_BACKEND", "postgres")
    with pytest.raises(RuntimeError):
        internal_api.uses_internal_persistence()
    monkeypatch.setenv("MIGRATION_ALLOW_CLOUD_POSTGRES", "true")
    assert not internal_api.uses_internal_persistence()
    monkeypatch.setenv("DEPLOYMENT_EDITION", "onprem")
    monkeypatch.setenv("PERSISTENCE_BACKEND", "d1")
    with pytest.raises(RuntimeError):
        internal_api.uses_internal_persistence()


@pytest.mark.parametrize("action,path", [("claim", "/internal/worker/jobs/claim"), ("account-delete/step", "/internal/worker/account-delete/step")])
def test_request_signature_exact_bytes_and_bounded_response(monkeypatch, action, path):
    monkeypatch.setenv("WORKER_INTERNAL_API_ORIGIN", "https://api.example.test")
    secret = "worker-test-key-0123456789-abcdefghijklmnop"
    monkeypatch.setenv("WORKER_INTERNAL_API_SECRET", secret)
    monkeypatch.setattr(internal_api.time, "time", lambda: 1800000000)
    response = MagicMock()
    response.__enter__.return_value.read.return_value = b'{"status":"completed"}'
    opener = MagicMock()
    opener.open.return_value = response
    monkeypatch.setattr(internal_api, "build_opener", lambda *args: opener)
    assert internal_api.call_internal_api(action, {"jobId": "日本語"}) == {"status": "completed"}
    request = opener.open.call_args.args[0]
    message = ("videoq-worker-v1\n1800000000\nPOST\nhttps://api.example.test\n"
               f"{path}\n").encode() + request.data
    assert request.get_header("X-videoq-worker-signature") == hmac.new(secret.encode(), message, hashlib.sha256).hexdigest()
    assert json.loads(request.data) == {"jobId": "日本語"}
    response.__enter__.return_value.read.assert_called_once_with(8193)
    response.__enter__.return_value.read.return_value = b"x" * 8193
    with pytest.raises(RuntimeError, match="API request failed"):
        internal_api.call_internal_api(action, {})


def test_cloud_job_lifecycle_never_opens_postgres(monkeypatch):
    monkeypatch.setenv("DEPLOYMENT_EDITION", "cloud")
    db = MagicMock(side_effect=AssertionError("PostgreSQL must not be used"))
    monkeypatch.setattr(job_execution, "db_connection", db)
    api = MagicMock(return_value={"status": "claimed", "leaseToken": "lease"})
    monkeypatch.setattr(job_execution, "call_internal_api", api)
    assert job_execution.claim_job_execution("j", "task", {"a": 1}) == "lease"
    api.return_value = {"status": "completed"}
    assert job_execution.claim_job_execution("j", "task", {"a": 1}) is None
    for status, error in [("busy", job_execution.JobExecutionBusyError), ("conflict", job_execution.JobIdentityConflictError)]:
        api.return_value = {"status": status}
        with pytest.raises(error):
            job_execution.claim_job_execution("j", "task", {})
    api.return_value = {"updated": True}
    job_execution.complete_job_execution("j", "lease")
    job_execution.fail_job_execution("j", "lease", "sensitive details")
    assert api.call_args.args[1]["errorCode"] == "WORKER_EXECUTION_FAILED"
    assert "sensitive" not in str(api.call_args)
    api.return_value = {"updated": False}
    with pytest.raises(RuntimeError, match="lease was lost"):
        job_execution.complete_job_execution("j", "lease")
    db.assert_not_called()


def test_d1_rejects_legacy_database_calls_even_with_database_url(monkeypatch):
    from worker_python.db import get_database_url
    monkeypatch.setenv("PERSISTENCE_BACKEND", "d1")
    monkeypatch.setenv("DATABASE_URL", "postgresql://must-not-be-used")
    with pytest.raises(RuntimeError, match="Direct PostgreSQL"):
        get_database_url()


def test_cloud_bootstrap_loads_api_key_without_reading_database_secret(monkeypatch):
    from worker_python import secrets_bootstrap as bootstrap
    import sys
    monkeypatch.setattr(bootstrap, "_LOADED", False)
    monkeypatch.setenv("DEPLOYMENT_EDITION", "cloud")
    monkeypatch.setenv("DB_PARAM_NAME", "/must-not-read/db")
    monkeypatch.setenv("APP_PARAM_NAME", "/app")
    # Register direct bootstrap writes for monkeypatch teardown.
    monkeypatch.setenv("WORKER_INTERNAL_API_SECRET", "")
    client = MagicMock()
    client.get_parameter.return_value = {"Parameter": {"Value": json.dumps({
        "WORKER_INTERNAL_API_SECRET": "a" * 40,
    })}}
    boto = MagicMock()
    boto.client.return_value = client
    monkeypatch.setitem(sys.modules, "boto3", boto)
    bootstrap.ensure_secrets_loaded()
    client.get_parameter.assert_called_once_with(Name="/app", WithDecryption=True)
    assert internal_api.os.environ["WORKER_INTERNAL_API_SECRET"] == "a" * 40
