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
from worker_python.pipeline.scene_otsu import apply_scene_splitting
from worker_python.pipeline.scene_otsu import embedders as scene_embedders
from worker_python.tasks import reindexing

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
    assert body["input_type"] == "document" and body["dimensions"] == 768
    embeddings.embed_texts(["How long are backups retained?"], input_type="query")
    assert json.loads(http.call_args.args[0].data)["input_type"] == "query"
    config = resolve_embedding_config()
    conn = MagicMock()
    conn.execute.return_value.fetchone.return_value = {"type_name": "vector", "dimensions": 768}
    assert_embedding_schema(conn, config)
    assert conn.execute.call_args.args[1] == ("public.scene_embeddings_768",)
    with pytest.raises(EmbeddingContractError):
        validate_embedding(VECTOR, config)


@pytest.mark.parametrize("environ, model", [
    ({"OPENROUTER_API_KEY": "router-key"}, "openai/text-embedding-3-small"),
    ({"EMBEDDING_BASE_URL": "https://openrouter.ai/api/v1"}, "openai/text-embedding-3-small"),
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


def test_config_errors_are_not_hidden_by_scene_fallback(monkeypatch):
    error = EmbeddingContractError("EMBEDDING_CONFIG_INVALID", "bad config")
    splitter = MagicMock()
    splitter.process.side_effect = error
    monkeypatch.setattr("worker_python.pipeline.scene_otsu.SceneSplitter", MagicMock(return_value=splitter))
    with pytest.raises(EmbeddingContractError):
        apply_scene_splitting("subtitle")


def test_reindex_schema_failure_stops_before_indexing(monkeypatch):
    error = EmbeddingContractError("EMBEDDING_OUTPUT_INVALID", "bad dimensions")
    index = MagicMock()
    monkeypatch.setattr(reindexing.vector_index, "check_embedding_storage", MagicMock(side_effect=error))
    monkeypatch.setattr(reindexing.vector_index, "index_video_transcript", index)
    with pytest.raises(EmbeddingContractError):
        reindexing._run_reindex([object()])
    index.assert_not_called()


@pytest.mark.parametrize("status", [400, 401, 403, 404, 422])
def test_provider_request_rejection_propagates_through_scene(monkeypatch, caplog, status):
    monkeypatch.setenv("EMBEDDING_MODEL", "model")
    monkeypatch.setenv("OPENAI_API_KEY", "test-key")
    body = "private input / credentials"
    responses = []
    http = MagicMock(side_effect=lambda *_args, **_kwargs: reject())

    def reject():
        response = BytesIO(body.encode())
        responses.append(response)
        raise HTTPError("http://example.invalid", status, body, {}, response)

    monkeypatch.setattr(embeddings.urllib.request, "urlopen", http)
    # Three cues require a semantic boundary choice; two have only one boundary.
    encoding = MagicMock()
    encoding.encode_ordinary.return_value = list(range(300))
    monkeypatch.setattr(scene_embedders, "_resolve_encoding", lambda: encoding)

    operations = [
        lambda: apply_scene_splitting(
            "1\n00:00:00,000 --> 00:00:01,000\nWater evaporates.\n\n"
            "2\n00:00:01,000 --> 00:00:02,000\nSteam condenses.\n\n"
            "3\n00:00:02,000 --> 00:00:03,000\nWater freezes.\n"
        ),
    ]
    for operation in operations:
        with pytest.raises(EmbeddingContractError) as caught:
            operation()
        assert caught.value.reason == "EMBEDDING_CONFIG_INVALID"
        assert f"HTTP {status}" in str(caught.value)
        assert body not in str(caught.value)
        assert responses[-1].closed
    assert body not in caplog.text
    assert http.call_count == len(operations)  # No retries without dimensions.


def test_separate_embedding_endpoint_and_credential(monkeypatch):
    http = response(monkeypatch, {"data": [{"index": 0, "embedding": VECTOR}]})
    monkeypatch.setenv("OPENAI_BASE_URL", "http://chat.test/v1")
    monkeypatch.setenv("EMBEDDING_BASE_URL", "http://embed.test/v1/")
    monkeypatch.setenv("EMBEDDING_API_KEY", "embedding-key")
    assert embeddings.embed_texts(["private text"]) == [VECTOR]
    request = http.call_args.args[0]
    assert request.full_url == "http://embed.test/v1/embeddings"
    assert request.get_header("Authorization") == "Bearer embedding-key"


def test_openrouter_shared_key_and_original_embedding_model(monkeypatch):
    monkeypatch.setenv("OPENROUTER_API_KEY", "router-key")
    for name in ("EMBEDDING_MODEL", "EMBEDDING_BASE_URL", "EMBEDDING_API_KEY", "OPENAI_BASE_URL"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("OPENAI_API_KEY", "old-direct-key")

    def request(req, **kwargs):
        assert req.full_url == "https://openrouter.ai/api/v1/embeddings"
        assert req.get_header("Authorization") == "Bearer router-key"
        assert json.loads(req.data) == {"model": "openai/text-embedding-3-small", "input": ["input"], "encoding_format": "float", "dimensions": 1536}
        return BytesIO(json.dumps({"data": [{"index": 0, "embedding": VECTOR}]}).encode())

    monkeypatch.setattr(embeddings.urllib.request, "urlopen", request)
    assert embeddings.embed_texts(["input"]) == [VECTOR]


def test_explicit_embedding_endpoint_does_not_receive_router_key(monkeypatch):
    monkeypatch.setenv("OPENROUTER_API_KEY", "router-key")
    monkeypatch.setenv("OPENAI_API_KEY", "direct-key")
    monkeypatch.setenv("EMBEDDING_BASE_URL", "https://api.openai.com/v1")
    monkeypatch.delenv("EMBEDDING_API_KEY", raising=False)
    monkeypatch.delenv("EMBEDDING_MODEL", raising=False)

    def request(req, **kwargs):
        assert req.get_header("Authorization") == "Bearer direct-key"
        assert json.loads(req.data)["model"] == "text-embedding-3-small"
        return BytesIO(json.dumps({"data": [{"index": 0, "embedding": VECTOR}]}).encode())

    monkeypatch.setattr(embeddings.urllib.request, "urlopen", request)
    assert embeddings.embed_texts(["input"]) == [VECTOR]


def test_router_endpoint_never_receives_a_legacy_direct_key(monkeypatch):
    monkeypatch.setenv("OPENAI_BASE_URL", "https://openrouter.ai/api/v1")
    monkeypatch.setenv("OPENAI_API_KEY", "direct-only-key")
    for name in ("OPENROUTER_API_KEY", "OPENROUTER_FEDERATION_POLICY_ID", "EMBEDDING_API_KEY", "EMBEDDING_BASE_URL"):
        monkeypatch.delenv(name, raising=False)
    request = MagicMock()
    monkeypatch.setattr(embeddings.urllib.request, "urlopen", request)
    with pytest.raises(RuntimeError, match="OPENROUTER_API_KEY"):
        embeddings.embed_texts(["fixture"])
    request.assert_not_called()
