"""Hosted/private OpenAI-compatible embeddings shared with the API."""

from __future__ import annotations

import json
import urllib.error
import urllib.request

from worker_python.env import env_str
from .ai_connection import shared_api_key, shared_base_url, is_openrouter
from .embedding_contract import (
    EmbeddingConfig,
    EmbeddingContractError,
    invalid_output,
    resolve_embedding_config,
    validate_embedding,
)


def embed_texts(texts: list[str], *, input_type: str = "document") -> list[list[float]]:
    if not texts:
        return []
    config = resolve_embedding_config()
    return _embed_openai_batch(texts, config, input_type=input_type)


def _embed_openai_batch(texts: list[str], config: EmbeddingConfig, *, input_type: str = "document") -> list[list[float]]:
    base = (env_str("EMBEDDING_BASE_URL") or shared_base_url()).rstrip("/")
    api_key = (shared_api_key(base) if is_openrouter(base) and env_str("OPENROUTER_FEDERATION_POLICY_ID")
               else env_str("EMBEDDING_API_KEY") or shared_api_key(base))
    if not api_key:
        raise RuntimeError("OPENROUTER_API_KEY, OPENAI_API_KEY or EMBEDDING_API_KEY is required for embeddings")
    body: dict = {"model": config.model, "input": texts, "encoding_format": "float", "dimensions": config.dimensions}
    if config.profile == "embeddinggemma2":
        if input_type not in {"query", "document"}:
            raise ValueError("input_type must be query or document")
        body["input_type"] = input_type

    req = urllib.request.Request(
        f"{base}/embeddings",
        data=json.dumps(body).encode("utf-8"),
        headers={
            "content-type": "application/json",
            "authorization": f"Bearer {api_key}",
        },
        method="POST",
    )
    payload = _request_payload(req, config)

    data = payload.get("data") if isinstance(payload, dict) else None
    if not isinstance(data, list) or len(data) != len(texts) or not all(
        isinstance(item, dict) and type(item.get("index")) is int for item in data
    ):
        raise invalid_output(config)
    ordered = sorted(data, key=lambda item: item["index"])
    if any(item["index"] != index for index, item in enumerate(ordered)):
        raise invalid_output(config)
    return [validate_embedding(item.get("embedding"), config) for item in ordered]


def _provider_http_error(config: EmbeddingConfig, status: int) -> RuntimeError:
    # Permanent request rejection (e.g. unsupported model/dimensions) must not
    # become a successful scene fallback. Preserve the
    # existing best-effort behavior for timeouts, rate limits and server failures.
    if 400 <= status < 500 and status not in {408, 429}:
        return EmbeddingContractError(
            "EMBEDDING_CONFIG_INVALID",
            f"OpenAI embeddings request rejected (HTTP {status}). "
            "Check the model, requested dimensions and provider configuration.",
            config,
        )
    return RuntimeError(f"OpenAI embeddings failed (HTTP {status}).")


def _request_payload(request: urllib.request.Request, config: EmbeddingConfig):
    try:
        with urllib.request.urlopen(request, timeout=120) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        with exc:
            raise _provider_http_error(config, exc.code) from None
    except urllib.error.URLError:
        raise RuntimeError("OpenAI embeddings request failed. Check the server connection.") from None
    except (ValueError, UnicodeError):
        raise invalid_output(config) from None
