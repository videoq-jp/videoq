import base64
import json

import httpx
import pytest

from worker_python.pipeline.workers_ai_whisper import MODEL, create_client, transcribe
from worker_python.pipeline import transcription


def test_request_language_timestamps_and_no_secret_in_failure(tmp_path):
    audio = tmp_path / "test.mp3"
    audio.write_bytes(b"public audio")
    def handler(request):
        assert request.url.path.endswith('/ai/run/' + MODEL)
        assert json.loads(request.content) == {"audio": base64.b64encode(b"public audio").decode(), "language": "ja", "task": "transcribe", "vad_filter": True, "condition_on_previous_text": False}
        return httpx.Response(200, json={"success": True, "result": {"segments": [{"start": 1, "end": 2, "text": "テスト"}]}})
    with httpx.Client(base_url="https://api.cloudflare.com/client/v4/accounts/test/ai/run/", transport=httpx.MockTransport(handler)) as client:
        assert transcribe(client, audio, offset=300, language="ja") == [{"start": 301, "end": 302, "text": "テスト"}]
    with httpx.Client(base_url="https://api.cloudflare.com/", transport=httpx.MockTransport(lambda r: httpx.Response(401, text="secret-token"))) as client:
        with pytest.raises(RuntimeError, match=r"^Workers AI transcription failed \(HTTP 401\)$"):
            transcribe(client, audio, offset=0)


@pytest.mark.parametrize("result", [
    {"text": "missing timestamps"},
    {"segments": [{"start": -1, "end": 2, "text": "bad"}]},
    {"segments": [{"start": True, "end": 2, "text": "bad"}]},
    {"segments": [{"start": 2, "end": 1, "text": "bad"}]},
])
def test_rejects_unusable_timestamps(tmp_path, result):
    audio = tmp_path / "test.mp3"
    audio.write_bytes(b"audio")
    with httpx.Client(base_url="https://api.cloudflare.com/", transport=httpx.MockTransport(lambda r: httpx.Response(200, json={"success": True, "result": result}))) as client:
        with pytest.raises(RuntimeError):
            transcribe(client, audio, offset=0)


def test_missing_credentials_fail_closed(monkeypatch):
    monkeypatch.delenv("WORKERS_AI_API_TOKEN", raising=False)
    with pytest.raises(RuntimeError, match="requires"):
        create_client()


def test_small_compressed_audio_is_still_split(monkeypatch, tmp_path):
    audio = tmp_path / "test.mp3"
    audio.write_bytes(b"audio")
    from contextlib import nullcontext
    monkeypatch.setattr(transcription, "_whisper_client", lambda: (nullcontext(), MODEL))
    def chunks(path, chunk_seconds):
        assert chunk_seconds == 300
        yield 0, audio
        yield 300, audio
    monkeypatch.setattr(transcription, "_split_audio_chunks", chunks)
    monkeypatch.setattr(transcription, "_whisper_file", lambda client, path, model, offset, language: [{"start": offset, "end": offset+1, "text": language}])
    assert transcription._whisper_transcribe(audio, language="ja")[1]["start"] == 300
