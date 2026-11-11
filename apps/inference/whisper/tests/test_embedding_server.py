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


@pytest.mark.parametrize("text", [
    "task: search result | query: How long are backups kept?",
    "title: none | text: バックアップは7日間保存します。",
])
def test_standard_openai_input_preserves_prompt_exactly_once(client, text):
    connection, model = client
    response = connection.post("/v1/embeddings", json={"model": service.MODEL_ALIAS, "input": text, "dimensions": 768})
    assert response.status_code == 200
    assert len(response.json()["data"][0]["embedding"]) == 768
    assert model.tokenizer.call_args.args[0] == [text]
    assert model.encode.call_args.args[0] == [text]
    assert model.encode.call_args.kwargs["prompt"] == ""
    assert model.encode.call_args.kwargs["normalize_embeddings"] is True


@pytest.mark.parametrize("overrides", [
    {"dimensions": 1536}, {"input_type": "unknown"}, {"input_type": None},
    {"input": []}, {"input": " "}, {"input": ["text"] * 65},
    {"input": ["a" * 8193]}, {"encoding_format": "base64"}, {"unknown": "value"},
])
def test_rejects_invalid_requests_before_inference(client, overrides):
    connection, model = client
    response = connection.post("/v1/embeddings", json={"model": service.MODEL_ALIAS, "input": "text", **overrides})
    assert response.status_code == 422
    model.encode.assert_not_called()


def test_cannot_choose_another_model_or_download_remote_weights(client):
    connection, model = client
    response = connection.post("/v1/embeddings", json={"model": "google/other-model", "input": "text"})
    assert response.status_code == 404
    model.encode.assert_not_called()


def test_cuda_request_never_falls_back_to_cpu(monkeypatch, tmp_path):
    import sys
    torch = MagicMock()
    torch.cuda.is_available.return_value = False
    constructor = MagicMock()
    monkeypatch.setitem(sys.modules, "torch", torch)
    monkeypatch.setitem(sys.modules, "sentence_transformers", MagicMock(SentenceTransformer=constructor))
    monkeypatch.setenv("EMBEDDING_MODEL_PATH", str(tmp_path))
    monkeypatch.setenv("EMBEDDING_DEVICE", "cuda")
    with pytest.raises(RuntimeError, match="refusing CPU fallback"):
        service.load_model()
    constructor.assert_not_called()


def test_cuda_loads_text_encoder_with_bounded_allocator(monkeypatch, tmp_path):
    import sys
    torch = MagicMock()
    constructor = MagicMock()
    constructor.return_value.get_sentence_embedding_dimension.return_value = 768
    constructor.return_value.prompts = {"SearchQuery": "query", "Document": "document"}
    monkeypatch.setitem(sys.modules, "torch", torch)
    monkeypatch.setitem(sys.modules, "sentence_transformers", MagicMock(SentenceTransformer=constructor))
    monkeypatch.setenv("EMBEDDING_MODEL_PATH", str(tmp_path))
    monkeypatch.setenv("EMBEDDING_DEVICE", "cuda")
    monkeypatch.setenv("EMBEDDING_GPU_MEMORY_FRACTION", "0.07")
    service.load_model()
    assert constructor.call_args.kwargs["device"] == "cuda"
    assert constructor.call_args.kwargs["model_kwargs"]["torch_dtype"] is torch.bfloat16
    assert constructor.call_args.kwargs["config_kwargs"] == {"vision_config": None, "audio_config": None}
    torch.cuda.set_per_process_memory_fraction.assert_called_once_with(0.07)
