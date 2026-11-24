import hashlib
import hmac
import json
from email.parser import BytesParser
from email.policy import default
from types import SimpleNamespace
from unittest.mock import MagicMock

import httpx
import pytest
from openai import APIStatusError

from worker_python.pipeline import transcription, workers_ai_transcription as adapter


@pytest.fixture
def audio(tmp_path):
    path = tmp_path / "audio.mp3"
    path.write_bytes(bytes([0, 255, 128, 13, 10]) + b"synthetic audio")
    return path


@pytest.fixture
def connection(monkeypatch):
    secret = "worker-test-secret-0123456789-abcdefghijklmnop"
    monkeypatch.setenv("WORKER_INTERNAL_API_ORIGIN", "https://api.example.test")
    monkeypatch.setenv("WORKER_INTERNAL_API_SECRET", secret)
    monkeypatch.setenv("WHISPER_BACKEND", "workers-ai")
    return secret


def install_transport(monkeypatch, handler):
    original = adapter.create_client
    monkeypatch.setattr(adapter, "create_client", lambda: original(transport=httpx.MockTransport(handler)))


def test_real_sdk_multipart_exact_binary_signature_no_api_key(monkeypatch, audio, connection):
    monkeypatch.setenv("OPENAI_API_KEY", "must-not-be-used")
    monkeypatch.setenv("CLOUDFLARE_API_TOKEN", "must-not-be-used")
    monkeypatch.setattr(transcription, "_ffprobe_duration", lambda _: 300)
    def handle(request):
        assert str(request.url) == "https://api.example.test/internal/worker/audio/transcriptions"
        assert "authorization" not in request.headers
        assert request.headers["user-agent"] == "VideoQ-Worker/1.0"
        assert request.extensions["timeout"]["read"] == 120
        body = request.content
        prefix = f"videoq-worker-v1\n{request.headers['x-videoq-worker-timestamp']}\nPOST\nhttps://api.example.test\n/internal/worker/audio/transcriptions\n".encode()
        assert request.headers['x-videoq-worker-signature'] == hmac.new(connection.encode(), prefix + body, hashlib.sha256).hexdigest()
        message = BytesParser(policy=default).parsebytes(b"Content-Type: " + request.headers['content-type'].encode() + b"\r\n\r\n" + body)
        fields = {part.get_param('name', header='content-disposition'): part.get_payload(decode=True) for part in message.iter_parts()}
        assert fields['file'] == audio.read_bytes()
        assert fields['language'] == b'ja' and fields['duration_seconds'] == b'300'
        assert fields['response_format'] == b'verbose_json' and fields['timestamp_granularities[]'] == b'segment'
        return httpx.Response(200, json={"task": "transcribe", "duration": 300, "text": "青空", "segments": [{"start": 1, "end": 2, "text": "青空"}]})
    install_transport(monkeypatch, handle)
    assert transcription._whisper_transcribe(audio, language="ja") == [{"start": 1, "end": 2, "text": "青空"}]


@pytest.mark.parametrize("segments,text", [
    (None, ""), ([{"start": True, "end": 1, "text": "word"}], "word"),
    ([{"start": 0, "end": 301, "text": "word"}], "word"),
    ([{"start": 0, "end": float('nan'), "text": "word"}], "word"),
    ([{"start": 0, "end": 1, "text": " "}], ""), ([], "without timestamps"),
])
def test_invalid_sdk_response_rejected(monkeypatch, audio, connection, segments, text):
    monkeypatch.setattr(transcription, "_ffprobe_duration", lambda _: 300)
    install_transport(monkeypatch, lambda _: httpx.Response(200, content=json.dumps({"text": text, "segments": segments}), headers={"content-type": "application/json"}))
    with pytest.raises(RuntimeError, match="Workers AI"):
        transcription._whisper_transcribe(audio)


@pytest.mark.parametrize("size", [0, 3_000_001])
def test_audio_bounds_before_network(monkeypatch, audio, connection, size):
    with audio.open("wb") as output: output.truncate(size)
    monkeypatch.setattr(transcription, "_ffprobe_duration", lambda _: 300)
    handler = MagicMock(side_effect=AssertionError("network"))
    install_transport(monkeypatch, handler)
    with pytest.raises(ValueError): transcription._whisper_transcribe(audio)
    handler.assert_not_called()


@pytest.mark.parametrize("status", [302, 503])
def test_failure_never_redirects_retries_or_falls_back(monkeypatch, audio, connection, status):
    monkeypatch.setattr(transcription, "_ffprobe_duration", lambda _: 30)
    handler = MagicMock(return_value=httpx.Response(status, json={"error": "TRANSCRIPTION_UNAVAILABLE"}, headers={"location": "https://other.invalid"}))
    install_transport(monkeypatch, handler)
    with pytest.raises(APIStatusError): transcription._whisper_transcribe(audio)
    handler.assert_called_once()


def test_response_stream_is_bounded(monkeypatch, audio, connection):
    monkeypatch.setattr(transcription, "_ffprobe_duration", lambda _: 30)
    class Large(httpx.SyncByteStream):
        def __iter__(self):
            for _ in range(100): yield b'x' * 65_536
    handler = MagicMock(return_value=httpx.Response(200, stream=Large()))
    install_transport(monkeypatch, handler)
    with pytest.raises(RuntimeError, match="response is too large"): transcription._whisper_transcribe(audio)
    handler.assert_called_once()


def test_interval_offset_once_and_language(monkeypatch, connection):
    def extract(command, **_):
        from pathlib import Path
        Path(command[-1]).write_bytes(b"audio")
        return SimpleNamespace(returncode=0, stderr="")
    monkeypatch.setattr(transcription, "run_media_process", extract)
    monkeypatch.setattr(transcription, "_ffprobe_duration", lambda _: 300.1)
    def handle(request):
        assert b'name="language"\r\n\r\nja' in request.content
        return httpx.Response(200, json={"text": "夕焼け", "segments": [{"start": 240, "end": 245, "text": "夕焼け"}]})
    install_transport(monkeypatch, handle)
    assert transcription.transcribe_audio_interval("source.mp4", 600, 300, language="ja") == [{"start": 840, "end": 845, "text": "夕焼け"}]


@pytest.mark.parametrize("fail", [False, True])
def test_long_audio_one_chunk_at_a_time_cleanup(monkeypatch, audio, connection, fail):
    monkeypatch.setattr(transcription, "_ffprobe_duration", lambda path: 601 if path == audio else 1 if path.name == "chunk_2.mp3" else 300.1)
    calls = []
    def extract(command, **_):
        from pathlib import Path
        assert not list(audio.parent.glob("chunk_*.mp3"))
        assert command[command.index("-t") + 1] == "300"
        Path(command[-1]).write_bytes(b"chunk")
        return SimpleNamespace(returncode=0, stderr="")
    def handle(request):
        assert len(list(audio.parent.glob("chunk_*.mp3"))) == 1
        assert b'name="language"' not in request.content
        calls.append(request)
        if fail and len(calls) == 2: return httpx.Response(503, json={"error": "TRANSCRIPTION_UNAVAILABLE"})
        return httpx.Response(200, json={"text": "音声", "segments": [{"start": 0.1, "end": 0.9, "text": "音声"}]})
    monkeypatch.setattr(transcription, "run_media_process", extract)
    install_transport(monkeypatch, handle)
    if fail:
        with pytest.raises(APIStatusError): transcription._whisper_transcribe(audio)
    else:
        assert [s['start'] for s in transcription._whisper_transcribe(audio)] == [0.1, 300.1, 600.1]
    assert not list(audio.parent.glob("chunk_*.mp3"))
