import json
import base64
import time

import httpx
import pytest

from worker_python.pipeline import embeddings, workers_ai_federation as federation
from worker_python.pipeline.embedding_contract import EmbeddingContractError

BASE = 'https://videoq.jp/api/internal/workers-ai'
VECTOR = [1.0] + [0.0] * 767


@pytest.fixture(autouse=True)
def settings(monkeypatch):
    for name, value in {'AI_PROVIDER':'workers-ai', 'EMBEDDING_PROFILE':'embeddinggemma2',
                        'EMBEDDING_MODEL':'@cf/google/embeddinggemma-2', 'EMBEDDING_BASE_URL':BASE,
                        'WORKERS_AI_FEDERATION_AUDIENCE':BASE, 'OPENAI_API_KEY':'obsolete',
                        'OPENROUTER_API_KEY':'obsolete'}.items():
        monkeypatch.setenv(name, value)
    claims = {'exp':int(time.time()) + 900, 'aud':[BASE]}
    token = 'header.' + base64.urlsafe_b64encode(json.dumps(claims).encode()).decode().rstrip('=') + '.signature'
    monkeypatch.setattr(federation, 'workload_token', lambda audience: token if audience == BASE else pytest.fail('Wrong audience'))


def transport(monkeypatch, handler):
    original = httpx.Client
    monkeypatch.setattr(httpx, 'Client', lambda **kwargs: original(transport=httpx.MockTransport(handler), **kwargs))


def test_batches_keyless_document_requests_without_double_prefixing(monkeypatch):
    calls = []
    def handler(request):
        body = json.loads(request.content)
        assert str(request.url) == BASE + '/embeddings'
        assert request.headers['authorization'].startswith('Bearer header.')
        assert body['input_type'] == 'document'
        assert all(text == '字幕' for text in body['texts'])
        calls.append(len(body['texts']))
        return httpx.Response(200, json={'data':[{'index':i, 'embedding':VECTOR} for i in range(len(body['texts']))]})
    transport(monkeypatch, handler)
    assert embeddings.embed_texts(['字幕'] * 33) == [VECTOR] * 33
    assert calls == [32, 1]


@pytest.mark.parametrize('data', [[{'index':0,'embedding':[1,2]}], [{'index':1,'embedding':VECTOR}], []])
def test_rejects_incompatible_vectors(monkeypatch, data):
    transport(monkeypatch, lambda request: httpx.Response(200, json={'data':data}))
    with pytest.raises(EmbeddingContractError):
        embeddings.embed_texts(['query'], input_type='query')


def test_rejects_redirects_without_forwarding_identity(monkeypatch):
    seen = []
    def handler(request):
        seen.append(str(request.url))
        return httpx.Response(307, headers={'Location':'https://attacker.invalid/'})
    transport(monkeypatch, handler)
    with pytest.raises(RuntimeError):
        embeddings.embed_texts(['query'])
    assert seen == [BASE + '/embeddings']


def test_rejects_unsafe_endpoint_and_wrong_profile(monkeypatch):
    for value in ['http://videoq.jp/api/internal/workers-ai', BASE + '?token=secret', 'https://u:p@videoq.jp/api/internal/workers-ai']:
        monkeypatch.setenv('EMBEDDING_BASE_URL', value)
        with pytest.raises(EmbeddingContractError):
            embeddings.embed_texts(['query'])
    monkeypatch.setenv('EMBEDDING_PROFILE','openai')
    with pytest.raises(EmbeddingContractError):
        embeddings.embed_texts(['query'])
