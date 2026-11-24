from io import BytesIO
from unittest.mock import MagicMock
from urllib.error import HTTPError
from urllib.parse import parse_qs, urlsplit

import pytest

from worker_python.pipeline import transcription


def test_manual_transcript_http_error_closes_before_automatic_fallback(monkeypatch):
    body = BytesIO(b"Manual transcript unavailable")
    error = HTTPError("https://example.invalid", 404, "Not Found", {}, body)
    response = BytesIO(b'{"transcript":[{"start":0,"duration":1,"text":"Hello"}]}')

    def respond(request, **_kwargs):
        if urlsplit(request.full_url).path.endswith("/info"):
            return BytesIO(b'{"available_languages":[{"code":"ja","kind":"manual"},{"code":"asr-ja","kind":"auto"}]}')
        query = parse_qs(urlsplit(request.full_url).query)
        assert query["language_fallback"] == ["false"]
        if query["language"] == ["ja"]:
            raise error
        assert body.closed
        return response

    http = MagicMock(side_effect=respond)
    monkeypatch.setattr(transcription, "urlopen", http)

    assert transcription._fetch_youtube_transcript("video", "test-key") == [
        {"start": 0, "duration": 1, "text": "Hello"}
    ]
    assert http.call_count == 3
    assert response.closed


def test_http_error_reads_only_a_bounded_prefix_and_closes_each_response(monkeypatch):
    class TrackedBody(BytesIO):
        bytes_read = 0

        def read(self, size=-1):
            data = super().read(size)
            self.bytes_read += len(data)
            return data

    # Four-byte UTF-8 characters still retain the full 300-character diagnostic.
    bodies = [TrackedBody(("😀" * 10_000).encode()) for _ in range(2)]
    errors = [HTTPError("https://example.invalid", 503, "Unavailable", {}, body) for body in bodies]
    monkeypatch.setattr(transcription, "urlopen", MagicMock(side_effect=[BytesIO(b'{"available_languages":[{"code":"ja","kind":"manual"},{"code":"asr-ja","kind":"auto"}]}'), *errors]))

    with pytest.raises(RuntimeError) as caught:
        transcription._fetch_youtube_transcript("video", "test-key")

    assert str(caught.value) == "TranscriptAPI HTTP 503: " + "😀" * 300
    assert all(body.closed for body in bodies)
    assert all(body.bytes_read <= 1200 for body in bodies)


def test_http_error_body_is_closed_even_when_reading_fails(monkeypatch):
    body = BytesIO()
    monkeypatch.setattr(body, "read", MagicMock(side_effect=OSError("Read failed")))
    error = HTTPError("https://example.invalid", 503, "Unavailable", {}, body)
    monkeypatch.setattr(transcription, "urlopen", MagicMock(side_effect=error))

    with pytest.raises(OSError, match="Read failed"):
        transcription._fetch_youtube_transcript("video", "test-key")
    assert body.closed


def test_manual_language_wins_over_english_automatic(monkeypatch):
    import json

    requests = []
    def respond(request, **kwargs):
        requests.append(request)
        assert request.get_header("Authorization") == "Bearer test-key"
        assert kwargs["timeout"] == 17
        if request.full_url.startswith("https://transcripts.example/api/v2/youtube/info?"):
            return BytesIO(json.dumps({"available_languages": [
                {"code": "asr-en", "kind": "auto"},
                {"code": "ja", "kind": "manual"},
                {"code": "de", "kind": "manual"},
            ]}).encode())
        query = parse_qs(urlsplit(request.full_url).query)
        assert query == {"video_url": ["video"], "format": ["json"],
                         "include_timestamp": ["true"], "language": ["ja"],
                         "language_fallback": ["false"]}
        return BytesIO(json.dumps({"transcript": [
            {"start": 1.25, "duration": 2.5, "text": "日本語\n字幕"},
            {"start": 5, "duration": 1, "text": "続き"},
        ]}).encode())

    monkeypatch.setenv("TRANSCRIPTAPI_BASE_URL", "https://transcripts.example/api/v2/")
    monkeypatch.setenv("TRANSCRIPTAPI_TIMEOUT_SECONDS", "17")
    monkeypatch.setattr(transcription, "urlopen", respond)
    srt, duration = transcription._transcribe_youtube("video", "test-key")
    assert srt == "1\n00:00:01,250 --> 00:00:03,750\n日本語 字幕\n\n2\n00:00:05,000 --> 00:00:06,000\n続き\n"
    assert duration == 6
    assert len(requests) == 2


@pytest.mark.parametrize("code", ["ja", "asr-ja"])
def test_auto_only_tracks_are_requested_explicitly(monkeypatch, code):
    import json

    requests = []
    def respond(request, **kwargs):
        requests.append(request)
        if len(requests) == 1:
            return BytesIO(json.dumps({"available_languages": [{"code": code, "kind": "auto"}]}).encode())
        assert parse_qs(urlsplit(request.full_url).query)["language"] == ["asr-ja"]
        return BytesIO(b'{"transcript":[{"start":0,"duration":1,"text":"Hello"}]}')
    monkeypatch.setattr(transcription, "urlopen", respond)
    assert transcription._fetch_youtube_transcript("video", "key")[0]["text"] == "Hello"


def test_empty_manual_transcript_falls_back_to_auto(monkeypatch):
    http = MagicMock(side_effect=[
        BytesIO(b'{"available_languages":[{"code":"ja","kind":"manual"},{"code":"asr-ja","kind":"auto"}]}'),
        BytesIO(b'{"transcript":[]}'),
        BytesIO(b'{"transcript":[{"start":0,"duration":1,"text":"Hello"}]}'),
    ])
    monkeypatch.setattr(transcription, "urlopen", http)
    assert transcription._fetch_youtube_transcript("video", "key")[0]["text"] == "Hello"
    assert http.call_count == 3


def test_no_available_tracks_preserves_no_transcript_error(monkeypatch):
    http = MagicMock(return_value=BytesIO(b'{"available_languages":[]}'))
    monkeypatch.setattr(transcription, "urlopen", http)
    with pytest.raises(RuntimeError, match="No transcript available for this YouTube video"):
        transcription._fetch_youtube_transcript("video", "key")
    assert http.call_count == 1


def test_missing_key_does_not_make_requests(monkeypatch):
    http = MagicMock()
    monkeypatch.setattr(transcription, "urlopen", http)
    with pytest.raises(RuntimeError, match="TranscriptAPI API key is not configured"):
        transcription._transcribe_youtube("video", " ")
    http.assert_not_called()


@pytest.mark.parametrize("kind,prefix", [("manual", ""), ("auto", "asr-")])
def test_english_first_within_each_caption_kind(monkeypatch, kind, prefix):
    import json

    requests = []
    def respond(request, **kwargs):
        requests.append(request)
        if len(requests) == 1:
            return BytesIO(json.dumps({"available_languages": [
                {"code": prefix + "ja", "kind": kind},
                {"code": prefix + "en", "kind": kind},
            ]}).encode())
        assert parse_qs(urlsplit(request.full_url).query)["language"] == [prefix + "en"]
        return BytesIO(b'{"transcript":[{"start":0,"duration":1,"text":"Hello"}]}')
    monkeypatch.setattr(transcription, "urlopen", respond)
    assert transcription._fetch_youtube_transcript("video", "key")[0]["text"] == "Hello"
