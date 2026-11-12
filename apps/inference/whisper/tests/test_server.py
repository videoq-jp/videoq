from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from threading import Event
from types import SimpleNamespace

from fastapi.testclient import TestClient
import httpx
import numpy as np
from openai import OpenAI
import pytest

import server


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setattr(server, "load_vad", lambda: object())
    calls, paths = [], []

    def decode(path, directory):
        paths.append(path)
        assert path.read_bytes()
        return np.zeros(4 * server.RATE, dtype=np.float32)

    monkeypatch.setattr(server, "decode_audio", decode)
    monkeypatch.setattr(server, "speech_spans", lambda _: [(0, server.RATE), (3 * server.RATE, 4 * server.RATE)])

    def upstream(request):
        assert request.url.host == "127.0.0.1" and request.url.port == 8081
        if request.url.path == "/health":
            return httpx.Response(200, json={"status": "ok"})
        assert request.url.path == "/v1/audio/transcriptions"
        calls.append(request)
        return httpx.Response(200, json={"language": "en", "text": " Caption",
            "segments": [{"start": .1, "end": 1.5, "text": " Caption"}]})

    with TestClient(server.app) as transport, httpx.Client(
        base_url=server.UPSTREAM, transport=httpx.MockTransport(upstream), trust_env=False,
    ) as engine:
        original = server.app.state.upstream
        server.app.state.upstream = engine
        try:
            yield transport, calls, paths
        finally:
            server.app.state.upstream = original


def post(client, **data):
    return client.post("/v1/audio/transcriptions", data={"model": "whisper-local", **data},
                       files={"file": ("clip.mp3", b"audio", "audio/mpeg")})


def test_real_sdk_multipart_restores_source_gaps_and_clamps_decoder_padding(client):
    transport, calls, paths = client
    with OpenAI(api_key="local", base_url="http://testserver/v1", http_client=transport) as sdk:
        response = sdk.audio.transcriptions.create(model="whisper-local", file=("clip.mp3", b"audio"),
            response_format="verbose_json", timestamp_granularities=["segment"])
    assert [(row.start, row.end) for row in response.segments] == [(.1, 1), (3.1, 4)]
    assert len(calls) == 2
    assert all(b'name="language"' not in request.content for request in calls)
    assert all(not path.exists() for path in paths)


def test_language_hint_is_optional_and_forwarded_without_fixing_japanese(client):
    transport, calls, _ = client
    assert post(transport, language="de").status_code == 200
    assert all(b'name="language"' in request.content and b"\r\n\r\nde\r\n" in request.content for request in calls)


def test_silence_returns_empty_without_contacting_the_engine(client, monkeypatch):
    transport, calls, _ = client
    monkeypatch.setattr(server, "speech_spans", lambda _: [])
    response = post(transport)
    assert response.status_code == 200
    assert response.json()["segments"] == []
    assert response.json()["text"] == ""
    assert calls == []


@pytest.mark.parametrize("budget,status,count,starts", [(600, 200, 3, [0, 2, 4]), (110, 504, 2, [0, 2, 4]), (110, 504, 2, [0, 2])])
def test_slow_cpu_spans_share_a_bounded_request_budget(client, monkeypatch, budget, status, count, starts):
    transport, _, _ = client
    clock, calls = [0], []
    monkeypatch.setattr(server, "time", SimpleNamespace(monotonic=lambda: clock[0]))
    monkeypatch.setattr(server.app.state, "request_timeout", budget)
    monkeypatch.setattr(server, "decode_audio", lambda *_: np.zeros(6 * server.RATE, dtype=np.float32))
    monkeypatch.setattr(server, "speech_spans", lambda _: [(i * server.RATE, (i + 1) * server.RATE) for i in starts])
    def upstream(request):
        calls.append(request)
        clock[0] += 75
        return httpx.Response(200, json={"segments": [{"start": .1, "end": 1, "text": "Caption"}]})
    original = server.app.state.upstream
    with httpx.Client(base_url=server.UPSTREAM, transport=httpx.MockTransport(upstream)) as engine:
        server.app.state.upstream = engine
        try:
            response = post(transport)
        finally:
            server.app.state.upstream = original
    assert response.status_code == status
    assert len(calls) == count
    if status == 200:
        assert [row["start"] for row in response.json()["segments"]] == [.1, 2.1, 4.1]


@pytest.mark.parametrize("fields", [{"model": "remote/model"}, {"response_format": "text"},
                                     {"language": "../ja"}, {"timestamp_granularities[]": "word"}])
def test_unsupported_request_cannot_select_weights_or_change_subtitle_protocol(client, fields):
    transport, calls, paths = client
    assert post(transport, **fields).status_code == 400
    assert calls == paths == []


def test_both_announced_and_chunked_body_limits_apply_before_spooling(client, monkeypatch):
    transport, calls, _ = client
    monkeypatch.setattr(server, "MAX_BODY_BYTES", 64)
    assert post(transport).status_code == 413
    response = transport.post("/v1/audio/transcriptions", content=iter([b"x" * 65]),
        headers={"Content-Type": "multipart/form-data; boundary=test"})
    assert response.status_code == 413
    assert calls == []


def test_file_limit_does_not_leave_temp_audio_or_poison_the_next_request(client, monkeypatch):
    transport, calls, paths = client
    monkeypatch.setattr(server, "MAX_AUDIO_BYTES", 3)
    assert post(transport).status_code == 413
    assert calls == paths == []
    monkeypatch.setattr(server, "MAX_AUDIO_BYTES", 100)
    assert post(transport).status_code == 200
    assert all(not path.exists() for path in paths)


def test_busy_rejection_bounds_uploads_and_releases_the_slot(client, monkeypatch):
    transport, _, _ = client
    entered, release = Event(), Event()
    decode = server.decode_audio

    def blocking_decode(*args):
        entered.set()
        assert release.wait(5)
        return decode(*args)

    monkeypatch.setattr(server, "decode_audio", blocking_decode)
    with ThreadPoolExecutor(max_workers=1) as executor:
        first = executor.submit(post, transport)
        try:
            assert entered.wait(5)
            response = post(transport)
            assert response.status_code == 503
            assert response.headers["Retry-After"] == "5"
        finally:
            release.set()
        assert first.result().status_code == 200
    assert post(transport).status_code == 200


@pytest.mark.parametrize("payload", [{"text": "without timestamps"},
    {"text": "caption", "segments": []}, {"segments": [{"start": True, "end": 1, "text": "bad"}]},
    {"segments": [{"start": 2, "end": 1, "text": "bad"}]}])
def test_invalid_upstream_response_is_rejected_and_temp_audio_is_removed(client, payload):
    transport, _, paths = client
    original = server.app.state.upstream
    with httpx.Client(base_url=server.UPSTREAM, transport=httpx.MockTransport(
        lambda _: httpx.Response(200, json=payload))) as engine:
        server.app.state.upstream = engine
        try:
            response = post(transport)
        finally:
            server.app.state.upstream = original
    assert response.status_code == 422
    assert all(not path.exists() for path in paths)
    assert post(transport).status_code == 200


def test_readiness_tracks_the_engine_but_liveness_does_not(client):
    transport, _, _ = client
    original = server.app.state.upstream
    assert transport.get("/health").status_code == 200
    with httpx.Client(base_url=server.UPSTREAM, transport=httpx.MockTransport(lambda _: httpx.Response(503))) as engine:
        server.app.state.upstream = engine
        try:
            assert transport.get("/health").status_code == 503
            assert transport.get("/live").status_code == 200
        finally:
            server.app.state.upstream = original


def test_long_pauses_are_not_packed_into_the_same_decoder_input():
    rate = server.RATE
    regions = [{"start": 0, "end": rate}, {"start": int(1.5 * rate), "end": 2 * rate},
               {"start": 3 * rate, "end": 4 * rate},
               {"start": 4 * rate, "end": 5 * rate}]
    assert server.merge_speech_spans(regions) == [(0, rate), (int(1.5 * rate), 2 * rate), (3 * rate, 5 * rate)]
