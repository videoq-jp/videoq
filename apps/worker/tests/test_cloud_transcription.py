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
