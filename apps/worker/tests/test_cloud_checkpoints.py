from unittest.mock import MagicMock

import pytest

from worker_python import transcription_checkpoints as checkpoints
from worker_python.tasks import segmented_transcription as task
from worker_python.video_sql import VideoRow


@pytest.fixture
def setup(monkeypatch):
    monkeypatch.setenv("PERSISTENCE_BACKEND", "d1")
    monkeypatch.setenv("VIDEO_VISUAL_ENABLED", "false")
    db = MagicMock(side_effect=AssertionError("PostgreSQL must not be used"))
    monkeypatch.setattr(checkpoints, "db_connection", db)
    monkeypatch.setattr(task, "db_connection", db)
    row = {"videoId": 1, "runId": "run", "fileKey": "file.mp4", "sourceRevision": "revision",
           "durationMs": 600_000, "chunkSeconds": 300, "chunkCount": 2, "completed": False,
           "transcriptionLanguage": "ja"}
    return row


def test_checkpoint_operations_use_internal_api(setup, monkeypatch):
    row = setup
    responses = {"checkpoints/load": {"run": row}, "checkpoints/initialize": {"run": row, "quotaExceeded": False},
                 "checkpoints/pending": {"indices": [0, 1]}, "checkpoints/state": {"active": True, "completed": False},
                 "checkpoints/save": {"accepted": True}, "checkpoints/failure": {"accepted": True}}
    api = MagicMock(side_effect=lambda action, body: responses[action])
    monkeypatch.setattr(checkpoints, "call_internal_api", api)
    run = checkpoints.load_run(1)
    video = VideoRow(1, "owner", "Video", None, "pending", "uploaded", "file.mp4", None, "revision")
    assert checkpoints.initialize_run(video, 600) == run
    assert checkpoints.pending_heads(run) == [0, 1]
    assert checkpoints.chunk_state(run, 0) == (True, False)
    assert checkpoints.save_chunk(run, 0, []) is True
    checkpoints.record_chunk_failure(run, 0, "sensitive provider error")
    assert "sensitive" not in str(api.call_args)
    responses["checkpoints/initialize"] = {"run": None, "quotaExceeded": True}
    with pytest.raises(checkpoints.TranscriptionQuotaError):
        checkpoints.initialize_run(video, 600)


def test_finalizer_assembles_pages_and_uses_atomic_handoff(setup, monkeypatch):
    row = setup
    run = checkpoints._cloud_run(row)
    calls = []
    def api(action, body):
        calls.append((action, body))
        if action == "checkpoints/segments":
            index = body["afterIndex"] + 1
            return {"active": True, "rows": [{"index": index, "segments": [{"start": index, "end": index+1, "text": f"text{index}"}]}], "done": index == 1}
        return {"completed": True, "stale": False, "status": "indexing"}
    monkeypatch.setattr(task, "call_internal_api", api)
    task._finish_cloud_run(run)
    assert calls[-1][0] == "checkpoints/finish"
    assert "text0" in calls[-1][1]["transcript"] and "text1" in calls[-1][1]["transcript"]
    assert len(calls) == 3


def test_incomplete_checkpoint_never_publishes(setup, monkeypatch):
    run = checkpoints._cloud_run(setup)
    api = MagicMock(return_value={"active": True, "rows": [{"index": 0, "segments": None}], "done": True})
    monkeypatch.setattr(task, "call_internal_api", api)
    with pytest.raises(RuntimeError, match="incomplete"):
        task._finish_cloud_run(run)
    assert api.call_count == 1


def test_completed_replay_does_not_download_segments(setup, monkeypatch):
    setup["completed"] = True
    run = checkpoints._cloud_run(setup)
    api = MagicMock(return_value={"completed": True, "stale": False, "status": "indexing"})
    monkeypatch.setattr(task, "call_internal_api", api)
    task._finish_cloud_run(run)
    api.assert_called_once_with("checkpoints/finish", {"videoId": 1, "runId": "run", "transcript": None})
