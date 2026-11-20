"""R2 credentials must use R2_* names, never Lambda reserved AWS_ACCESS_KEY_ID."""

from __future__ import annotations

import os

import pytest

import worker_python.secrets_bootstrap as bootstrap


@pytest.fixture(autouse=True)
def isolate_bootstrap_environment(monkeypatch):
    monkeypatch.setattr(bootstrap, "_LOADED", False)
    # Bootstrap writes env directly. Record even absent keys for fixture teardown.
    keys = {
        "DATABASE_URL",
        *bootstrap._APP_ENV_MAP.values(),
        "R2_ACCESS_KEY_ID",
        "R2_SECRET_ACCESS_KEY",
        "AWS_STORAGE_BUCKET_NAME",
        "AWS_S3_ENDPOINT_URL",
        "AWS_S3_REGION_NAME",
    }
    for key in keys:
        monkeypatch.setenv(key, os.environ.get(key, ""))


def test_canonical_r2_keys_from_app_param(monkeypatch):
    monkeypatch.setenv("APP_PARAM_NAME", "/videoq/prod/app")
    monkeypatch.setenv("AWS_ACCESS_KEY_ID", "ASIA_ROLE_EXAMPLE")
    monkeypatch.setenv("AWS_SECRET_ACCESS_KEY", "role-secret")
    for key in (
        "R2_ACCESS_KEY_ID",
        "R2_SECRET_ACCESS_KEY",
        "R2_BUCKET_NAME",
        "R2_S3_ENDPOINT",
        "R2_S3_REGION",
        "AWS_STORAGE_BUCKET_NAME",
        "AWS_S3_ENDPOINT_URL",
        "AWS_S3_REGION_NAME",
        "DB_PARAM_NAME",
        "DB_SECRET_ARN",
        "APP_SECRET_ARN",
    ):
        monkeypatch.delenv(key, raising=False)

    class FakeClient:
        def close(self):
            pass

        def get_parameter(self, Name, WithDecryption):  # noqa: N803
            assert Name == "/videoq/prod/app"
            assert WithDecryption is True
            return {
                "Parameter": {
                    "Value": (
                        '{"R2_ACCESS_KEY_ID":"AKIA_R2","R2_SECRET_ACCESS_KEY":"r2-secret",'
                        '"R2_BUCKET_NAME":"videoq-media-prod",'
                        '"R2_S3_ENDPOINT":"https://example.r2.cloudflarestorage.com",'
                        '"R2_S3_REGION":"auto"}'
                    )
                }
            }

    class FakeBoto3:
        def client(self, name):
            assert name == "ssm"
            return FakeClient()

    monkeypatch.setitem(__import__("sys").modules, "boto3", FakeBoto3())
    bootstrap.ensure_secrets_loaded()

    assert os.environ["AWS_ACCESS_KEY_ID"] == "ASIA_ROLE_EXAMPLE"
    assert os.environ["R2_ACCESS_KEY_ID"] == "AKIA_R2"
    assert os.environ["R2_SECRET_ACCESS_KEY"] == "r2-secret"
    assert os.environ["R2_BUCKET_NAME"] == "videoq-media-prod"
    assert os.environ["R2_S3_ENDPOINT"] == "https://example.r2.cloudflarestorage.com"
    # Every storage caller reads canonical keys; no legacy write-back is needed.
    assert "AWS_STORAGE_BUCKET_NAME" not in os.environ
    assert "AWS_S3_ENDPOINT_URL" not in os.environ
    assert "AWS_S3_REGION_NAME" not in os.environ


def test_legacy_aws_secret_keys_map_to_r2(monkeypatch):
    monkeypatch.setenv("APP_PARAM_NAME", "/videoq/prod/app")
    monkeypatch.setenv("AWS_ACCESS_KEY_ID", "ASIA_ROLE_EXAMPLE")
    monkeypatch.setenv("AWS_SECRET_ACCESS_KEY", "role-secret")
    for key in (
        "R2_ACCESS_KEY_ID",
        "R2_SECRET_ACCESS_KEY",
        "R2_BUCKET_NAME",
        "DB_PARAM_NAME",
        "DB_SECRET_ARN",
        "APP_SECRET_ARN",
    ):
        monkeypatch.delenv(key, raising=False)

    class FakeClient:
        def close(self):
            pass

        def get_parameter(self, Name, WithDecryption):  # noqa: N803
            return {
                "Parameter": {
                    "Value": (
                        '{"AWS_ACCESS_KEY_ID":"AKIA_LEGACY","AWS_SECRET_ACCESS_KEY":"legacy",'
                        '"AWS_STORAGE_BUCKET_NAME":"videoq-media-prod"}'
                    )
                }
            }

    class FakeBoto3:
        def client(self, name):
            assert name == "ssm"
            return FakeClient()

    monkeypatch.setitem(__import__("sys").modules, "boto3", FakeBoto3())
    bootstrap.ensure_secrets_loaded()

    assert os.environ["AWS_ACCESS_KEY_ID"] == "ASIA_ROLE_EXAMPLE"
    assert os.environ["R2_ACCESS_KEY_ID"] == "AKIA_LEGACY"
    assert os.environ["R2_BUCKET_NAME"] == "videoq-media-prod"


def test_legacy_env_names_still_resolve_params(monkeypatch):
    """DB_SECRET_ARN / APP_SECRET_ARN env keys can hold SSM names during cutover."""
    monkeypatch.setenv("DB_SECRET_ARN", "/videoq/prod/db")
    monkeypatch.delenv("DB_PARAM_NAME", raising=False)
    monkeypatch.delenv("APP_PARAM_NAME", raising=False)
    monkeypatch.delenv("APP_SECRET_ARN", raising=False)
    monkeypatch.delenv("DATABASE_URL", raising=False)

    class FakeClient:
        def close(self):
            pass

        def get_parameter(self, Name, WithDecryption):  # noqa: N803
            assert Name == "/videoq/prod/db"
            return {
                "Parameter": {"Value": '{"DATABASE_URL":"postgresql://example/db"}'}
            }

    class FakeBoto3:
        def client(self, name):
            assert name == "ssm"
            return FakeClient()

    monkeypatch.setitem(__import__("sys").modules, "boto3", FakeBoto3())
    bootstrap.ensure_secrets_loaded()

    assert os.environ["DATABASE_URL"] == "postgresql://example/db"


def test_transient_ssm_failure_does_not_poison_the_container(monkeypatch):
    """A failed bootstrap must be retried, not silently skipped forever."""
    monkeypatch.setenv("DB_PARAM_NAME", "/videoq/prod/db")
    for key in ("DATABASE_URL", "APP_PARAM_NAME", "APP_SECRET_ARN", "DB_SECRET_ARN"):
        monkeypatch.delenv(key, raising=False)

    attempts = {"count": 0}

    class FlakyClient:
        def close(self):
            pass

        def get_parameter(self, Name, WithDecryption):  # noqa: N803
            attempts["count"] += 1
            if attempts["count"] == 1:
                raise RuntimeError("ssm unavailable")
            return {"Parameter": {"Value": '{"DATABASE_URL":"postgresql://db/x"}'}}

    class FakeBoto3:
        def client(self, name):
            return FlakyClient()

    monkeypatch.setitem(__import__("sys").modules, "boto3", FakeBoto3())

    with pytest.raises(RuntimeError):
        bootstrap.ensure_secrets_loaded()
    assert bootstrap._LOADED is False
    assert "DATABASE_URL" not in os.environ

    # 同じ warm container 上の次の呼び出しで再試行され、今度は成功する。
    bootstrap.ensure_secrets_loaded()
    assert attempts["count"] == 2
    assert os.environ["DATABASE_URL"] == "postgresql://db/x"
    assert bootstrap._LOADED is True


def test_missing_param_refs_still_mark_loaded(monkeypatch):
    for key in ("DB_PARAM_NAME", "DB_SECRET_ARN", "APP_PARAM_NAME", "APP_SECRET_ARN"):
        monkeypatch.delenv(key, raising=False)

    bootstrap.ensure_secrets_loaded()

    assert bootstrap._LOADED is True


def test_openrouter_key_is_loaded_from_shared_app_secret(monkeypatch):
    import json
    from types import SimpleNamespace

    monkeypatch.setenv("APP_PARAM_NAME", "/videoq/prod/app")
    for key in ("OPENROUTER_API_KEY", "DB_PARAM_NAME", "APP_SECRET_ARN", "DB_SECRET_ARN"):
        monkeypatch.delenv(key, raising=False)
    client = SimpleNamespace(
        close=lambda: None,
        get_parameter=lambda **_: {"Parameter": {"Value": json.dumps({"OPENROUTER_API_KEY": "router-key"})}},
    )
    monkeypatch.setitem(__import__("sys").modules, "boto3", SimpleNamespace(client=lambda _: client))
    bootstrap.ensure_secrets_loaded()
    assert os.environ["OPENROUTER_API_KEY"] == "router-key"
