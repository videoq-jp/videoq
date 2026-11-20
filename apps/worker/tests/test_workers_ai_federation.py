import base64
import json
import time

import httpx
import pytest

from worker_python.pipeline import workers_ai_federation as federation
from worker_python.pipeline.workers_ai_whisper import create_client, transcribe

ENDPOINT = 'https://videoq.jp/api/internal/workers-ai/transcribe'


@pytest.fixture(autouse=True)
def reset(monkeypatch):
    monkeypatch.setattr(federation, '_CACHE', None)
    monkeypatch.setenv('AWS_REGION', 'ap-northeast-1')
    monkeypatch.setenv('WORKERS_AI_BASE_URL', ENDPOINT)
    # A stale API key must never be used as a fallback.
    monkeypatch.setenv('WORKERS_AI_API_TOKEN', 'obsolete-static-token')


def fake_sts(monkeypatch, *, fail=False):
    calls = []
    claims = {'exp': int(time.time()) + 900, 'aud': [ENDPOINT]}
    token = 'header.' + base64.urlsafe_b64encode(json.dumps(claims).encode()).decode().rstrip('=') + '.signature'
    class STS:
        def close(self): pass
        def get_web_identity_token(self, **kwargs):
            calls.append(kwargs)
            if fail: raise RuntimeError('SECRET SIGNED REQUEST')
            return {'WebIdentityToken': token}
    import boto3
    monkeypatch.setattr(boto3, 'client', lambda *a, **kw: STS())
    return calls, token


def test_keyless_client_caches_and_refreshes_aws_token(monkeypatch, tmp_path):
    calls, token = fake_sts(monkeypatch)
    audio = tmp_path/'audio.mp3'; audio.write_bytes(b'fixture')
    requests = []
    def handler(request):
        assert str(request.url) == ENDPOINT
        assert request.headers['authorization'] == f'Bearer {token}'
        assert 'obsolete' not in str(request.headers)
        requests.append(request)
        return httpx.Response(200,json={'success':True,'result':{'segments':[{'start':0,'end':1,'text':'test'}]}})
    # Keep production client URL/auth configuration, replacing only its transport.
    with create_client() as configured:
        with httpx.Client(base_url=configured.base_url,auth=configured.auth,transport=httpx.MockTransport(handler)) as client:
            for offset in [0,300]:
                assert transcribe(client,audio,offset=offset)[0]['start']==offset
            assert len(calls)==1
            monkeypatch.setattr(federation,'_CACHE',(federation._CACHE[0],token,time.time()+30))
            transcribe(client,audio,offset=600)
    assert len(calls)==2 and len(requests)==3
    assert calls[0]=={'Audience':[ENDPOINT],'SigningAlgorithm':'RS256','DurationSeconds':900}


def test_no_fallback_on_sts_failure(monkeypatch):
    fake_sts(monkeypatch,fail=True)
    with pytest.raises(RuntimeError,match='^Workers AI workload identity failed;') as error:
        federation.workload_token(ENDPOINT)
    assert 'SECRET' not in str(error.value)
    assert federation._CACHE is None


def test_refuses_redirect_or_wrong_identity_destination(monkeypatch):
    fake_sts(monkeypatch)
    with create_client() as configured:
        assert configured.follow_redirects is False
        with httpx.Client(auth=configured.auth,transport=httpx.MockTransport(lambda r:httpx.Response(200))) as client:
            with pytest.raises(RuntimeError,match='destination mismatch'):
                client.post('https://attacker.invalid/transcribe')


@pytest.mark.parametrize('endpoint',['http://videoq.jp/api/internal/workers-ai/transcribe','https://user:password@videoq.jp/api/internal/workers-ai/transcribe','https://videoq.jp/wrong','https://videoq.jp/api/internal/workers-ai/transcribe?secret=bad'])
def test_invalid_endpoint(monkeypatch,endpoint):
    monkeypatch.setenv('WORKERS_AI_BASE_URL',endpoint)
    with pytest.raises(RuntimeError,match='HTTPS WORKERS_AI_BASE_URL'):
        create_client()
