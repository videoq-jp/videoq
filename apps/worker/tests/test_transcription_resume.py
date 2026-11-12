from __future__ import annotations

from contextlib import contextmanager
from unittest.mock import MagicMock

import pytest

from worker_python.tasks import indexing, transcription
from worker_python.video_sql import VideoRow


def _video(status: str) -> VideoRow:
    return VideoRow(
        id=42,
        user_id="u1",
        title="Title",
        transcript=None,
        status=status,
        source_type="uploaded",
        file_key="videos/u1/42.mp4",
        youtube_video_id="",
    )


def test_indexing_status_retry_resumes_only_index_handoff(monkeypatch) -> None:
    conn = MagicMock()

    @contextmanager
    def fake_connection():
        yield conn

    enqueue = MagicMock(return_value="message-1")
    run = MagicMock()
    load = MagicMock(return_value=_video("indexing"))
    monkeypatch.setattr(transcription, "db_connection", fake_connection)
    monkeypatch.setattr(transcription, "get_video_for_task", load)
    monkeypatch.setattr(transcription, "enqueue_job", enqueue)
    monkeypatch.setattr(transcription, "run_transcription", run)

    transcription.transcribe_video(42, job_id="transcribe-job")

    load.assert_called_once_with(conn, 42, include_transcript=False)
    run.assert_not_called()
    enqueue.assert_called_once()
    assert enqueue.call_args.kwargs["job_id"]


def test_completed_status_duplicate_is_a_noop(monkeypatch) -> None:
    conn = MagicMock()

    @contextmanager
    def fake_connection():
        yield conn

    load = MagicMock(return_value=_video("completed"))
    monkeypatch.setattr(transcription, "db_connection", fake_connection)
    monkeypatch.setattr(transcription, "get_video_for_task", load)
    run = MagicMock()
    enqueue = MagicMock()
    monkeypatch.setattr(transcription, "run_transcription", run)
    monkeypatch.setattr(transcription, "enqueue_job", enqueue)

    transcription.transcribe_video(42, job_id="transcribe-job")

    load.assert_called_once_with(conn, 42, include_transcript=False)
    run.assert_not_called()
    enqueue.assert_not_called()


def test_indexing_handoff_runs_real_task_when_queue_is_unavailable(monkeypatch):
    video = _video("indexing")
    video.transcript = "1\n00:00:00,000 --> 00:00:01,000\nHello"
    conn = MagicMock()

    @contextmanager
    def connection():
        yield conn

    @contextmanager
    def lock(video_id):
        assert video_id == 42
        yield

    for module in (transcription, indexing):
        monkeypatch.setattr(module, "db_connection", connection)
        monkeypatch.setattr(module, "get_video_for_task", lambda *_args, **_kwargs: video)
    monkeypatch.setattr(indexing, "video_vector_write_lock", lock)
    monkeypatch.setattr(transcription, "enqueue_job", MagicMock(return_value=None))
    write = MagicMock(return_value=1)
    transition = MagicMock(return_value=True)
    monkeypatch.setattr(indexing.vector_index, "index_video_transcript", write)
    monkeypatch.setattr(indexing, "finish_video_indexing", transition)

    transcription.transcribe_video(42, job_id="transcribe-job")

    write.assert_called_once_with(video)
    transition.assert_called_once_with(conn, video)


@pytest.mark.parametrize("status", ["pending", "processing", "error"])
def test_transcription_only_requests_metadata(monkeypatch, status):
    conn = MagicMock()

    @contextmanager
    def fake_connection():
        yield conn

    video = _video(status)
    load = MagicMock(return_value=video)
    run = MagicMock(return_value="new transcript")
    save = MagicMock(return_value="indexing")
    enqueue = MagicMock(return_value="message-1")
    monkeypatch.setattr(transcription, "db_connection", fake_connection)
    monkeypatch.setattr(transcription, "get_video_for_task", load)
    monkeypatch.setattr(transcription, "run_transcription", run)
    monkeypatch.setattr(transcription, "finish_transcription", save)
    monkeypatch.setattr(transcription, "enqueue_job", enqueue)
    monkeypatch.setattr(transcription, "transition_video_status", MagicMock(return_value=True))

    transcription.transcribe_video(42, job_id="transcribe-job")

    load.assert_called_once_with(conn, 42, include_transcript=False)
    run.assert_called_once()
    assert run.call_args.args == (video,)
    save.assert_called_once_with(conn, video, transcript="new transcript", error_message="")
    enqueue.assert_called_once()


@pytest.mark.parametrize("status", ["uploading", "unknown"])
def test_transcription_rejects_unready_status_before_writes_or_provider_work(monkeypatch, status):
    conn = MagicMock()

    @contextmanager
    def connection():
        yield conn

    run = MagicMock()
    transition = MagicMock()
    finish = MagicMock()
    enqueue = MagicMock()
    monkeypatch.setattr(transcription, "db_connection", connection)
    monkeypatch.setattr(transcription, "get_video_for_task", lambda *_args, **_kwargs: _video(status))
    monkeypatch.setattr(transcription, "run_transcription", run)
    monkeypatch.setattr(transcription, "transition_video_status", transition)
    monkeypatch.setattr(transcription, "finish_transcription", finish)
    monkeypatch.setattr(transcription, "enqueue_job", enqueue)

    with pytest.raises(Exception, match=status):
        transcription.transcribe_video(42)

    run.assert_not_called()
    transition.assert_not_called()
    finish.assert_not_called()
    enqueue.assert_not_called()
