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


@pytest.mark.parametrize("status,attempts", [(401, 1), (402, 1), (404, 1), (408, 3), (429, 3), (503, 3)])
def test_http_errors_close_responses_and_retry_only_documented_statuses(monkeypatch, caplog, status, attempts):
    secret = "private-provider-response-and-token"
    bodies = [BytesIO(secret.encode()) for _ in range(attempts)]
    errors = [HTTPError("https://example.invalid/" + secret, status, secret, {}, body) for body in bodies]
    http = MagicMock(side_effect=errors)
    sleep = MagicMock()
    monkeypatch.setattr(transcription, "urlopen", http)
    monkeypatch.setattr(transcription.time, "sleep", sleep)
    with pytest.raises(transcription.TranscriptApiError) as caught:
        transcription._fetch_youtube_transcript("video", "key")
    assert caught.value.status == status
    assert http.call_count == attempts
    assert sleep.call_count == attempts - 1
    assert all(body.closed for body in bodies)
    assert secret not in str(caught.value) + caplog.text
    assert f"operation=info status={status}" in caplog.text


def test_http_error_diagnostics_never_read_provider_response_bodies(monkeypatch):
    body = BytesIO()
    read = MagicMock(side_effect=OSError("private response read failure"))
    monkeypatch.setattr(body, "read", read)
    error = HTTPError("https://example.invalid", 401, "Unauthorized", {}, body)
    monkeypatch.setattr(transcription, "urlopen", MagicMock(side_effect=error))
    with pytest.raises(transcription.TranscriptApiError, match="HTTP 401"):
        transcription._fetch_youtube_transcript("video", "key")
    assert body.closed
    read.assert_not_called()


@pytest.mark.parametrize("header,expected", [(None, 1), ("5", 5), ("invalid", 1),
    ("Wed, 01 Jan 2031 00:00:05 GMT", 5)])
def test_retry_after_is_honored_before_repeating_the_same_caption_request(monkeypatch, header, expected):
    from datetime import datetime, timezone
    monkeypatch.setattr(transcription.time, "time", lambda: datetime(2031, 1, 1, tzinfo=timezone.utc).timestamp())
    body = BytesIO(b"private transient failure")
    error = HTTPError("https://example.invalid", 408, "Retry", {"Retry-After": header} if header else {}, body)
    responses = iter([
        BytesIO(b'{"available_languages":[{"code":"ja","kind":"auto"},{"code":"asr-ja","kind":"auto"}]}'),
        error,
        BytesIO(b'{"transcript":[{"start":0,"duration":1,"text":"Recovered"}]}'),
    ])
    requests = []
    def respond(request, **kwargs):
        requests.append(request)
        item = next(responses)
        if isinstance(item, Exception):
            raise item
        assert len(requests) == 1 or body.closed
        return item
    sleep = MagicMock()
    monkeypatch.setattr(transcription, "urlopen", respond)
    monkeypatch.setattr(transcription.time, "sleep", sleep)
    assert transcription._fetch_youtube_transcript("video", "key")[0]["text"] == "Recovered"
    sleep.assert_called_once_with(expected)
    assert requests[1].full_url == requests[2].full_url
    assert parse_qs(urlsplit(requests[2].full_url).query)["language"] == ["asr-ja"]


def test_long_retry_after_does_not_retry_early_or_sleep_past_inline_budget(monkeypatch):
    error = HTTPError("https://example.invalid", 429, "Retry", {"Retry-After": "120"}, BytesIO())
    http, sleep = MagicMock(side_effect=error), MagicMock()
    monkeypatch.setattr(transcription, "urlopen", http)
    monkeypatch.setattr(transcription.time, "sleep", sleep)
    with pytest.raises(transcription.TranscriptApiError):
        transcription._fetch_youtube_transcript("video", "key")
    assert http.call_count == 1
    sleep.assert_not_called()


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
