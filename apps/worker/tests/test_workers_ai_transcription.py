import base64
import hashlib
import hmac
import json
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

from worker_python import internal_api
from worker_python.pipeline import transcription, workers_ai_transcription as adapter


@pytest.fixture
def audio(tmp_path):
    path = tmp_path / "audio.mp3"
    path.write_bytes(b"synthetic audio")
    return path


def test_signed_channel_uses_exact_audio_bytes_bounded_response_and_asr_timeout(monkeypatch, audio):
    secret = "worker-test-secret-0123456789-abcdefghijklmnop"
    monkeypatch.setenv("WORKER_INTERNAL_API_ORIGIN", "https://api.example.test")
    monkeypatch.setenv("WORKER_INTERNAL_API_SECRET", secret)
    reply = {"model": adapter.MODEL, "segments": [{"start": 1, "end": 2, "text": "青空"}]}
    response = MagicMock()
    response.__enter__.return_value.read.return_value = json.dumps(reply).encode()
    opener = MagicMock()
    opener.open.return_value = response
    monkeypatch.setattr(internal_api, "build_opener", lambda *_: opener)
    assert adapter.transcribe_file(audio, 300, language="ja") == reply["segments"]
    request = opener.open.call_args.args[0]
    assert request.full_url == "https://api.example.test/internal/worker/audio/transcribe"
    payload = json.loads(request.data)
    assert base64.b64decode(payload["audio"]) == audio.read_bytes()
    assert payload["language"] == "ja" and payload["durationSeconds"] == 300
    timestamp = request.get_header("X-videoq-worker-timestamp")
    message = f"videoq-worker-v1\n{timestamp}\nPOST\nhttps://api.example.test\n/internal/worker/audio/transcribe\n".encode() + request.data
    assert request.get_header("X-videoq-worker-signature") == hmac.new(secret.encode(), message, hashlib.sha256).hexdigest()
    assert opener.open.call_args.kwargs["timeout"] == 120
    response.__enter__.return_value.read.assert_called_once_with(1_000_001)


@pytest.mark.parametrize("reply", [
    {"model": "wrong", "segments": []}, {"model": adapter.MODEL},
    {"model": adapter.MODEL, "segments": [{"start": True, "end": 1, "text": "word"}]},
    {"model": adapter.MODEL, "segments": [{"start": 0, "end": 301, "text": "word"}]},
    {"model": adapter.MODEL, "segments": [{"start": 0, "end": float('nan'), "text": "word"}]},
    {"model": adapter.MODEL, "segments": [{"start": 0, "end": 1, "text": " "}]},
])
def test_provider_contract_is_validated_before_returning_any_segments(monkeypatch, audio, reply):
    monkeypatch.setattr(adapter, "call_internal_api", lambda *_: reply)
    with pytest.raises(RuntimeError, match="Invalid Workers AI"):
        adapter.transcribe_file(audio, 300)


@pytest.mark.parametrize("size", [0, 3_000_001])
def test_audio_is_bounded_before_encoding_or_network_calls(monkeypatch, audio, size):
    with audio.open("wb") as output:
        output.truncate(size)
    infer = MagicMock()
    monkeypatch.setattr(adapter, "call_internal_api", infer)
    with pytest.raises(ValueError):
        adapter.transcribe_file(audio, 300)
    infer.assert_not_called()


def test_inference_failure_never_falls_back_to_another_provider(monkeypatch, audio):
    monkeypatch.setenv("WHISPER_BACKEND", "workers-ai")
    monkeypatch.setattr(transcription, "_ffprobe_duration", lambda _: 30)
    client = MagicMock(side_effect=AssertionError("provider fallback"))
    monkeypatch.setattr(transcription, "_whisper_client", client)
    def fail(*_):
        raise internal_api.InternalApiError(503)
    monkeypatch.setattr(adapter, "call_internal_api", fail)
    with pytest.raises(internal_api.InternalApiError):
        transcription._whisper_transcribe(audio)
    client.assert_not_called()


def test_interval_applies_source_offset_once_and_preserves_language(monkeypatch):
    monkeypatch.setenv("WHISPER_BACKEND", "workers-ai")
    def extract(command, **_):
        from pathlib import Path
        Path(command[-1]).write_bytes(b"audio")
        return SimpleNamespace(returncode=0, stderr="")
    monkeypatch.setattr(transcription, "run_media_process", extract)
    monkeypatch.setattr(transcription, "_ffprobe_duration", lambda _: 300.1)
    infer = MagicMock(return_value={"model": adapter.MODEL, "segments": [{"start": 240, "end": 245, "text": "夕焼け"}]})
    monkeypatch.setattr(adapter, "call_internal_api", infer)
    assert transcription.transcribe_audio_interval("source.mp4", 600, 300, language="ja") == [
        {"start": 840, "end": 845, "text": "夕焼け"},
    ]
    assert infer.call_args.args[1]["language"] == "ja"


@pytest.mark.parametrize("fail", [False, True])
def test_long_audio_uses_one_bounded_chunk_at_a_time_and_cleans_up(monkeypatch, audio, fail):
    monkeypatch.setenv("WHISPER_BACKEND", "workers-ai")
    monkeypatch.setattr(transcription, "_ffprobe_duration", lambda path: 601 if path == audio else 1 if path.name == "chunk_2.mp3" else 300.1)
    calls = []
    def extract(command, **_):
        from pathlib import Path
        assert not list(audio.parent.glob("chunk_*.mp3"))
        assert command[command.index("-t") + 1] == "300"
        Path(command[-1]).write_bytes(b"chunk")
        return SimpleNamespace(returncode=0, stderr="")
    def infer(_action, payload):
        assert len(list(audio.parent.glob("chunk_*.mp3"))) == 1
        calls.append(payload)
        if fail and len(calls) == 2:
            raise internal_api.InternalApiError(503)
        return {"model": adapter.MODEL, "segments": [{"start": 0.1, "end": 0.9, "text": "音声"}]}
    monkeypatch.setattr(transcription, "run_media_process", extract)
    monkeypatch.setattr(adapter, "call_internal_api", infer)
    if fail:
        with pytest.raises(internal_api.InternalApiError):
            transcription._whisper_transcribe(audio)
    else:
        assert [s["start"] for s in transcription._whisper_transcribe(audio)] == [0.1, 300.1, 600.1]
    assert not list(audio.parent.glob("chunk_*.mp3"))
    assert all("language" not in payload for payload in calls)
