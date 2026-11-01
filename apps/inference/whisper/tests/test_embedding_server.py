from unittest.mock import MagicMock

from fastapi.testclient import TestClient
import numpy as np
import pytest

import embedding_server as service


@pytest.fixture
def client(monkeypatch):
    model = MagicMock()
    model.prompts = {"SearchQuery": "task: search result | query: ", "Document": "title: none | text: "}
    model.max_seq_length = 8192
    model.tokenizer.side_effect = lambda texts, **_: {"input_ids": [[1] * len(text) for text in texts]}
    model.encode.side_effect = lambda texts, **_: np.array([[1.0] + [0.0] * 767 for _ in texts])
    monkeypatch.setattr(service, "load_model", lambda: model)
    with TestClient(service.app) as connection:
        yield connection, model


def test_applies_asymmetric_prompts_for_japanese_and_english(client):
    connection, model = client
    for task, texts, prompt in [
        ("query", "How long are backups kept?", "SearchQuery"),
        ("document", ["バックアップは7日間保存します。", "Backups are retained for seven days."], "Document"),
    ]:
        response = connection.post("/v1/embeddings", json={"model": service.MODEL_ALIAS, "input": texts, "input_type": task, "dimensions": 768})
        assert response.status_code == 200
        rows = response.json()["data"]
        assert all(len(row["embedding"]) == 768 for row in rows)
        assert model.encode.call_args.kwargs["prompt_name"] == prompt
        assert model.encode.call_args.kwargs["normalize_embeddings"] is True


@pytest.mark.parametrize("overrides", [
    {"dimensions": 1536}, {"input_type": "unknown"}, {"input_type": None},
    {"input": []}, {"input": " "}, {"input": ["text"] * 65},
    {"input": ["a" * 8192]}, {"encoding_format": "base64"}, {"unknown": "value"},
])
def test_rejects_invalid_requests_before_inference(client, overrides):
    connection, model = client
    response = connection.post("/v1/embeddings", json={"model": service.MODEL_ALIAS, "input": "text", "input_type": "query", **overrides})
    assert response.status_code == 422
    model.encode.assert_not_called()


def test_cannot_choose_another_model_or_download_remote_weights(client):
    connection, model = client
    response = connection.post("/v1/embeddings", json={"model": "google/other-model", "input": "text", "input_type": "query"})
    assert response.status_code == 404
    model.encode.assert_not_called()
