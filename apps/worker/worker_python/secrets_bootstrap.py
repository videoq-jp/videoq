"""Load SSM SecureString payloads into process env for Lambda.

Lambda injects reserved AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY for the
execution role. R2 credentials must therefore live under R2_* names in
APP_PARAM_NAME and are loaded into R2_* process env vars.
"""

from __future__ import annotations

import json
import logging
import os
from contextlib import closing

from worker_python.env import credential_pair

logger = logging.getLogger(__name__)

_LOADED = False

# Canonical app-secret key → process env (skip if already set).
_APP_ENV_MAP = {
    "OPENAI_API_KEY": "OPENAI_API_KEY",
    "OPENROUTER_API_KEY": "OPENROUTER_API_KEY",
    "OPENROUTER_FEDERATION_POLICY_ID": "OPENROUTER_FEDERATION_POLICY_ID",
    "OPENROUTER_FEDERATION_AUDIENCE": "OPENROUTER_FEDERATION_AUDIENCE",
    "OPENAI_BASE_URL": "OPENAI_BASE_URL",
    "EMBEDDING_BASE_URL": "EMBEDDING_BASE_URL",
    "EMBEDDING_API_KEY": "EMBEDDING_API_KEY",
    "EMBEDDING_MODEL": "EMBEDDING_MODEL",
    "WHISPER_BACKEND": "WHISPER_BACKEND",
    "OPENAI_BASE_URL": "OPENAI_BASE_URL",
    "LLM_MODEL": "LLM_MODEL",
    "EMBEDDING_BASE_URL": "EMBEDDING_BASE_URL",
    "EMBEDDING_MODEL": "EMBEDDING_MODEL",
    "EMBEDDING_API_KEY": "EMBEDDING_API_KEY",
    "WHISPER_LOCAL_URL": "WHISPER_LOCAL_URL",
    "WHISPER_LOCAL_MODEL": "WHISPER_LOCAL_MODEL",
    "WHISPER_LOCAL_API_KEY": "WHISPER_LOCAL_API_KEY",
    "USER_SECRET_ENCRYPTION_KEY": "USER_SECRET_ENCRYPTION_KEY",
    "R2_BUCKET_NAME": "R2_BUCKET_NAME",
    "R2_S3_ENDPOINT": "R2_S3_ENDPOINT",
    "R2_S3_REGION": "R2_S3_REGION",
    # Legacy aliases (pre-R2_* rename). Prefer canonical keys above.
    "AWS_STORAGE_BUCKET_NAME": "R2_BUCKET_NAME",
    "AWS_S3_ENDPOINT_URL": "R2_S3_ENDPOINT",
    "AWS_S3_REGION_NAME": "R2_S3_REGION",
}


def ensure_secrets_loaded() -> None:
    """Load secrets once per warm container.

    ``_LOADED`` is only set after the load succeeds. Setting it up front would
    make a single transient SSM failure poison the container for its whole
    lifetime: every later invocation would skip the bootstrap and run without
    DATABASE_URL, so SQS would keep redelivering onto the same broken container.
    """
    global _LOADED
    if _LOADED:
        return

    db_param = (
        ""
        if os.environ.get("DATABASE_URL", "").strip()
        else _param_ref("DB_PARAM_NAME", "DB_SECRET_ARN")
    )
    app_param = _param_ref("APP_PARAM_NAME", "APP_SECRET_ARN")
    if not db_param and not app_param:
        _LOADED = True
        return

    import boto3

    updates: dict[str, str] = {}
    with closing(boto3.client("ssm")) as client:
        if db_param:
            payload = _get_json_parameter(client, db_param)
            url = payload.get("DATABASE_URL")
            if not isinstance(url, str) or not url.strip():
                raise ValueError("DB_PARAM_NAME must contain a non-empty DATABASE_URL string")
            updates["DATABASE_URL"] = url.strip()

        if app_param:
            payload = _get_json_parameter(client, app_param)
            pair = (
                credential_pair(os.environ, "R2")
                or credential_pair(payload, "R2")
                or credential_pair(payload, "AWS")
            )
            if pair:
                updates["R2_ACCESS_KEY_ID"], updates["R2_SECRET_ACCESS_KEY"] = pair
            # Prefer canonical R2_* secret keys over legacy AWS_* aliases when both exist.
            for src, dest in _APP_ENV_MAP.items():
                if os.environ.get(dest, "").strip() or dest in updates:
                    continue
                value = payload.get(src)
                if value is None:
                    continue
                if not isinstance(value, str):
                    raise ValueError(f"{src} must be a string")
                if value.strip():
                    updates[dest] = value.strip()

    # A failed load must leave the environment unchanged for the next invocation.
    os.environ.update(updates)
    _LOADED = True
    logger.info("Loaded configured SSM parameters")


def _param_ref(*env_keys: str) -> str:
    for key in env_keys:
        value = os.environ.get(key, "").strip()
        if value:
            return value
    return ""


def _get_json_parameter(client: object, name: str) -> dict:
    response = client.get_parameter(Name=name, WithDecryption=True)  # type: ignore[attr-defined]
    raw = (response.get("Parameter") or {}).get("Value")
    if not isinstance(raw, str) or not raw.strip():
        raise ValueError("SSM parameter must contain a JSON object")
    data = json.loads(raw)
    if not isinstance(data, dict):
        raise ValueError("SSM parameter must contain a JSON object")
    return data
