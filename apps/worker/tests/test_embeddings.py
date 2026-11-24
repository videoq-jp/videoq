from __future__ import annotations

import json
from dataclasses import asdict
from io import BytesIO
from unittest.mock import MagicMock
from urllib.error import HTTPError

import pytest

from worker_python.pipeline import embeddings
from worker_python.pipeline.embedding_contract import (
    EMBEDDING_DIMENSIONS, EmbeddingContractError, resolve_embedding_config, validate_embedding,
)
from worker_python.pipeline.embedding_schema import assert_embedding_schema

VECTOR = [1.0] + [0.0] * (1536 - 1)


def test_fixed_dimension():
    assert EMBEDDING_DIMENSIONS == 1536


def test_embeddinggemma_document_and_query_contract(monkeypatch):
    monkeypatch.setenv("EMBEDDING_PROFILE", "embeddinggemma2")
    monkeypatch.setenv("EMBEDDING_MODEL", "embeddinggemma-2-f9972ac")
    vector = [1.0] + [0.0] * 767
    http = response(monkeypatch, {"data": [{"index": 0, "embedding": vector}]})
    monkeypatch.setenv("EMBEDDING_BASE_URL", "http://embedding.test/v1")
    assert embeddings.embed_texts(["バックアップは7日間保存します。"]) == [vector]
    body = json.loads(http.call_args.args[0].data)
    assert "input_type" not in body and "dimensions" not in body
    assert body["input"] == ["title: none | text: バックアップは7日間保存します。"]
    embeddings.embed_texts(["How long are backups retained?"], input_type="query")
    assert json.loads(http.call_args.args[0].data)["input"] == ["task: search result | query: How long are backups retained?"]
    config = resolve_embedding_config()
    conn = MagicMock()
    conn.execute.return_value.fetchone.return_value = {"type_name": "vector", "dimensions": 768}
    assert_embedding_schema(conn, config)
    assert conn.execute.call_args.args[1] == ("public.scene_embeddings_768",)
    with pytest.raises(EmbeddingContractError):
        validate_embedding(VECTOR, config)


@pytest.mark.parametrize("environ, model", [
    ({}, "text-embedding-3-small"),
    ({"EMBEDDING_MODEL": "  "}, "text-embedding-3-small"),
    ({"EMBEDDING_MODEL": " CustomModel "}, "CustomModel"),
])
def test_settings(environ, model):
    assert asdict(resolve_embedding_config(environ)) == {"provider": "openai", "model": model, "profile": "openai"}


@pytest.mark.parametrize("vector", [
    [], [1, 2], [1] * 2560, [0] * 1536, None,
    ["1"] + VECTOR[1:], [True] + VECTOR[1:],
    [float("nan")] + VECTOR[1:], [float("inf")] + VECTOR[1:],
    [1e300] + VECTOR[1:], [1e-300] + VECTOR[1:],
])
def test_rejects_invalid_vectors(vector):
    with pytest.raises(EmbeddingContractError) as caught:
        validate_embedding(vector, resolve_embedding_config({}))
    assert caught.value.reason == "EMBEDDING_OUTPUT_INVALID"


def response(monkeypatch, payload):
    urlopen = MagicMock(side_effect=lambda *args, **kwargs: BytesIO(json.dumps(payload).encode()))
    monkeypatch.setattr(embeddings.urllib.request, "urlopen", urlopen)
    monkeypatch.setenv("OPENAI_API_KEY", "test-key")
    monkeypatch.delenv("OPENAI_BASE_URL", raising=False)
    monkeypatch.delenv("EMBEDDING_BASE_URL", raising=False)
    monkeypatch.delenv("EMBEDDING_API_KEY", raising=False)
    return urlopen


def test_provider_uses_fixed_dimension_and_validates_batch(monkeypatch):
    monkeypatch.setenv("EMBEDDING_MODEL", "model")
    first_vector = [0.0, 1.0] + [0.0] * (EMBEDDING_DIMENSIONS - 2)
    payload = {"data": [{"index": 1, "embedding": VECTOR}, {"index": 0, "embedding": first_vector}]}
    http = response(monkeypatch, payload)
    assert embeddings.embed_texts(["first", "second"]) == [first_vector, VECTOR]
    request = http.call_args.args[0]
    assert json.loads(request.data) == {"model": "model", "input": ["first", "second"], "dimensions": 1536, "encoding_format": "float"}
    assert request.full_url.endswith("/v1/embeddings")


@pytest.mark.parametrize("indices", [[0, 0], [1, 2], [0], [0, True], [0, "1"]])
def test_openai_batch_rejects_missing_duplicate_and_invalid_indices(monkeypatch, indices):
    response(monkeypatch, {"data": [{"index": i, "embedding": VECTOR} for i in indices]})
    with pytest.raises(EmbeddingContractError):
        embeddings.embed_texts(["first", "second"])


@pytest.mark.parametrize("payload", [{"data": [{"index": 0, "embedding": [1] * 2560}]}, {"embedding": VECTOR}, None])
def test_private_invalid_response_never_falls_back(monkeypatch, payload):
    monkeypatch.setenv("EMBEDDING_MODEL", "wrong-size")
    http = response(monkeypatch, payload)
    with pytest.raises(EmbeddingContractError):
        embeddings.embed_texts(["input"])
    http.assert_called_once()


@pytest.mark.parametrize("payload", [b"not json", b"\xff"])
def test_invalid_provider_payload_closes_response(monkeypatch, payload):
    monkeypatch.setenv("EMBEDDING_MODEL", "model")
    monkeypatch.setenv("OPENAI_API_KEY", "test-key")
    response = BytesIO(payload)
    monkeypatch.setattr(embeddings.urllib.request, "urlopen", MagicMock(return_value=response))

    with pytest.raises(EmbeddingContractError) as caught:
        embeddings.embed_texts(["input"])
    assert caught.value.reason == "EMBEDDING_OUTPUT_INVALID"
    assert response.closed


@pytest.mark.parametrize("row", [None, {"type_name": "vector", "dimensions": 1024}, {"type_name": "vector", "dimensions": -1}, {"type_name": "text", "dimensions": 1536}])
def test_declared_schema_rejects_incompatible_empty_tables(row):
    conn = MagicMock()
    conn.execute.return_value.fetchone.return_value = row
    with pytest.raises(EmbeddingContractError) as caught:
        assert_embedding_schema(conn, resolve_embedding_config({}))
    assert caught.value.reason == "EMBEDDING_SCHEMA_MISMATCH"


def test_separate_embedding_endpoint_and_credential(monkeypatch):
    http = response(monkeypatch, {"data": [{"index": 0, "embedding": VECTOR}]})
    monkeypatch.setenv("OPENAI_BASE_URL", "http://chat.test/v1")
    monkeypatch.setenv("EMBEDDING_BASE_URL", "http://embed.test/v1/")
    monkeypatch.setenv("EMBEDDING_API_KEY", "embedding-key")
    assert embeddings.embed_texts(["private text"]) == [VECTOR]
    request = http.call_args.args[0]
    assert request.full_url == "http://embed.test/v1/embeddings"
    assert request.get_header("Authorization") == "Bearer embedding-key"


def workers_ai_settings(monkeypatch):
    monkeypatch.setenv("EMBEDDING_PROVIDER", "workers-ai")
    monkeypatch.setenv("EMBEDDING_PROFILE", "embeddinggemma2")
    monkeypatch.setenv("EMBEDDING_MODEL", "@cf/google/embeddinggemma-2")
    monkeypatch.delenv("EMBEDDING_BASE_URL", raising=False)


def test_workers_ai_config_and_batch_contract(monkeypatch):
    workers_ai_settings(monkeypatch)
    vector = [1.0] + [0.0] * 767
    api = MagicMock(side_effect=lambda action, payload: {
        "model": payload["model"], "profile": payload["profile"], "dimensions": 768,
        "embeddings": [vector for _ in payload["texts"]],
    })
    monkeypatch.setattr(embeddings, "call_internal_api", api)
    http = MagicMock(side_effect=AssertionError("Direct provider request must not be used"))
    monkeypatch.setattr(embeddings.urllib.request, "urlopen", http)
    texts = [f"字幕{i}" for i in range(33)]
    assert embeddings.embed_texts(texts) == [vector] * 33
    assert api.call_count == 2
    assert api.call_args_list[0].args == ("embeddings/generate", {
        "model": "@cf/google/embeddinggemma-2", "profile": "embeddinggemma2", "dimensions": 768,
        "inputType": "document", "texts": texts[:32],
    })
    embeddings.embed_texts(["質問"], input_type="query")
    assert api.call_args.args[1]["inputType"] == "query"
    assert api.call_args.args[1]["texts"] == ["質問"]  # Worker adds prefix once.
    assert resolve_embedding_config().provider == "workers-ai"


@pytest.mark.parametrize("change", [{"model": "other"}, {"profile": "openai"}, {"dimensions": 1536}, {"dimensions": True}, {"embeddings": []}, {"embeddings": [VECTOR]}])
def test_workers_ai_rejects_response_drift(monkeypatch, change):
    workers_ai_settings(monkeypatch)
    monkeypatch.setattr(embeddings, "call_internal_api", MagicMock(return_value={
        "model": "@cf/google/embeddinggemma-2", "profile": "embeddinggemma2", "dimensions": 768,
        "embeddings": [[1.0] + [0.0] * 767], **change,
    }))
    with pytest.raises(EmbeddingContractError):
        embeddings.embed_texts(["字幕"])


def test_workers_ai_permanent_errors_are_not_scene_fallbacks(monkeypatch):
    from worker_python.internal_api import InternalApiError
    workers_ai_settings(monkeypatch)
    api = MagicMock(side_effect=InternalApiError(409))
    monkeypatch.setattr(embeddings, "call_internal_api", api)
    with pytest.raises(EmbeddingContractError) as error:
        embeddings.embed_texts(["字幕"])
    assert error.value.reason == "EMBEDDING_CONFIG_INVALID"
    api.side_effect = InternalApiError(503)
    with pytest.raises(InternalApiError):
        embeddings.embed_texts(["字幕"])


@pytest.mark.parametrize("settings", [
    {"EMBEDDING_PROVIDER": "unknown"},
    {"EMBEDDING_PROVIDER": "workers-ai"},
    {"EMBEDDING_PROVIDER": "workers-ai", "EMBEDDING_PROFILE": "embeddinggemma2", "EMBEDDING_MODEL": "local-gemma"},
])
def test_workers_ai_invalid_settings(settings):
    with pytest.raises(EmbeddingContractError):
        resolve_embedding_config(settings)
