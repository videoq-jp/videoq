from unittest.mock import MagicMock

import pytest
from worker_python.tasks import cloud_transcription as task
from worker_python.tasks.transcription import TranscriptionExecutionFailedError


@pytest.fixture
def setup(monkeypatch):
    source = {"videoId": 1, "userId": "owner", "sourceRevision": "revision", "fileKey": "",
              "title": "Video", "status": "pending", "sourceType": "youtube", "youtubeVideoId": "yt"}
    calls = []
    def api(action, body):
        calls.append((action, body))
        if action.endswith("/source"):
            return {"source": source}
        if action.endswith("/begin"):
            return {"accepted": True}
        return {"status": "indexing" if body["transcript"] is not None else "error"}
    monkeypatch.setattr(task, "call_internal_api", api)
    monkeypatch.setattr(task, "heavy_pipeline_enabled", lambda: False)
    monkeypatch.setattr(task, "run_transcription", lambda *args, **kwargs: "Generated")
    return source, calls


def test_success_saves_once_and_outbox_owns_handoff(setup):
    source, calls = setup
    task.transcribe_cloud_video(1)
    assert [action for action, _ in calls] == ["transcription/source", "transcription/begin", "transcription/finish"]
    assert calls[-1][1]["transcript"] == "Generated"
    source["status"] = "indexing"
    task.transcribe_cloud_video(1)
    assert calls[-1][0] == "transcription/source"


def test_quota_denial_saves_safe_code_without_transcript(setup, monkeypatch):
    source, calls = setup
    monkeypatch.setattr(task, "reserve_video_processing", lambda *args: MagicMock(allowed=False))
    monkeypatch.setattr(task, "run_transcription", lambda *args, **kwargs: kwargs["reserve_processing"](60))
    task.transcribe_cloud_video(1)
    assert calls[-1][1]["errorCode"] == "PROCESSING_QUOTA_EXCEEDED"
    assert calls[-1][1]["transcript"] is None


def test_provider_failure_never_sends_exception_details(setup, monkeypatch):
    source, calls = setup
    monkeypatch.setattr(task, "run_transcription", MagicMock(side_effect=RuntimeError("secret=value")))
    with pytest.raises(TranscriptionExecutionFailedError):
        task.transcribe_cloud_video(1)
    assert calls[-1][1]["errorCode"] == "TRANSCRIPTION_FAILED"
    assert "secret=value" not in str(calls)


def test_uploads_use_segmented_checkpoints(setup, monkeypatch):
    from worker_python.tasks import segmented_transcription
    source, calls = setup
    source["sourceType"] = "uploaded"
    source["fileKey"] = "file.mp4"
    monkeypatch.setattr(task, "heavy_pipeline_enabled", lambda: True)
    start = MagicMock()
    monkeypatch.setattr(segmented_transcription, "start_uploaded_transcription", start)
    task.transcribe_cloud_video(1)
    assert start.call_args.args[0].transcript_hash == "revision"
    assert len(calls) == 1


def test_cloud_entrypoint_does_not_open_postgres(monkeypatch):
    from worker_python.tasks import transcription
    monkeypatch.setenv("PERSISTENCE_BACKEND", "d1")
    monkeypatch.setattr(transcription, "db_connection", MagicMock(side_effect=AssertionError("PG")))
    run = MagicMock()
    monkeypatch.setattr(task, "transcribe_cloud_video", run)
    transcription.transcribe_video(1)
    run.assert_called_once_with(1)


@pytest.mark.parametrize('accepted', [True, False])
def test_segmented_quota_recovery_maps_safe_code_and_preserves_source_fence(setup, monkeypatch, accepted):
    from worker_python.tasks import segmented_transcription
    from worker_python.domain.transcription_checkpoints import TranscriptionQuotaError
    source, calls = setup
    source.update(sourceType='uploaded', fileKey='file.mp4')
    monkeypatch.setattr(task, 'heavy_pipeline_enabled', lambda: True)
    monkeypatch.setattr(segmented_transcription, 'start_uploaded_transcription', MagicMock(side_effect=TranscriptionQuotaError('private quota detail')))
    original_api = task.call_internal_api
    def api(action, body):
        result = original_api(action, body)
        return {'accepted': accepted} if action == 'transcription/begin' else result
    monkeypatch.setattr(task, 'call_internal_api', api)
    task.transcribe_cloud_video(1)
    assert [action for action, _ in calls] == ['transcription/source', 'transcription/begin'] + (['transcription/finish'] if accepted else [])
    assert 'private quota detail' not in str(calls)
    if accepted:
        assert calls[-1][1] == {'videoId': 1, 'userId': 'owner', 'sourceRevision': 'revision', 'fileKey': 'file.mp4', 'transcript': None, 'errorCode': 'PROCESSING_QUOTA_EXCEEDED'}


@pytest.mark.parametrize("override", [True, False])
def test_youtube_transcriptapi_key_reaches_pipeline_in_cloud_mode(setup, monkeypatch, override):
    source, _ = setup
    source["searchapiKeyEncrypted"] = "encrypted-transcript-key"
    monkeypatch.delenv("TRANSCRIPTAPI_API_KEY", raising=False)
    monkeypatch.setenv("SEARCHAPI_API_KEY", "old-search-key")
    monkeypatch.setattr(task, "try_decrypt", lambda value: "saved-transcript-key" if value == "encrypted-transcript-key" else None)
    if override:
        monkeypatch.setenv("TRANSCRIPTAPI_API_KEY", "override-transcript-key")
    pipeline = MagicMock(return_value="Generated")
    monkeypatch.setattr(task, "run_transcription", pipeline)
    task.transcribe_cloud_video(1)
    assert pipeline.call_args.kwargs["searchapi_key"] == (
        "override-transcript-key" if override else "saved-transcript-key"
    )
