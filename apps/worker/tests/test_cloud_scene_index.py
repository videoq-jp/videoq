from unittest.mock import MagicMock

import pytest

from worker_python.pipeline import cloud_scene_index as index
from worker_python.pipeline.srt import SrtScene


@pytest.fixture
def setup(monkeypatch):
    source = {"videoId": 1, "userId": "owner", "sourceRevision": "revision", "transcript": "srt"}
    calls = []

    def api(action, body):
        calls.append((action, body))
        return {"source": source} if action.endswith("/source") else {"accepted": True}

    monkeypatch.setattr(index, "call_internal_api", api)
    monkeypatch.setattr(index, "apply_scene_splitting", lambda text: text)
    monkeypatch.setattr(index, "resolve_embedding_config", lambda: MagicMock(dimensions=1536))
    monkeypatch.setattr(index, "embed_texts", lambda texts: [[0.5] * 1536 for _ in texts])
    scenes = [SrtScene(i, "00:00:00,000", "00:00:01,000", 0, 1, f"text{i}") for i in range(43)]
    monkeypatch.setattr(index, "parse_srt_scenes", lambda text: scenes)
    return source, calls


def test_chunks_publish_only_after_all_embedding_batches(setup):
    source, calls = setup
    assert index.reindex_cloud_video(1) == 43
    assert [call[0] for call in calls] == ["scene-index/source", "scene-index/start",
        "scene-index/stage", "scene-index/stage", "scene-index/stage", "scene-index/publish"]
    assert [len(body["scenes"]) for action, body in calls if action.endswith("/stage")] == [20, 20, 3]
    assert calls[1][1]["sourceRevision"] == source["sourceRevision"]
    assert len({scene["id"] for action, body in calls if action.endswith("/stage") for scene in body["scenes"]}) == 43


def test_empty_caption_publishes_empty_run_without_embedding(setup, monkeypatch):
    source, calls = setup
    source["transcript"] = ""
    embedding = MagicMock(side_effect=AssertionError("must not embed"))
    monkeypatch.setattr(index, "embed_texts", embedding)
    assert index.reindex_cloud_video(1) == 0
    assert calls[1][1]["expectedScenes"] == 0
    assert calls[-1][0] == "scene-index/publish"
    embedding.assert_not_called()


def test_stale_stage_does_not_publish(setup, monkeypatch):
    source, calls = setup
    original = index.call_internal_api
    monkeypatch.setattr(index, "call_internal_api", lambda action, body:
        {"accepted": False} if action.endswith("/stage") else original(action, body))
    with pytest.raises(RuntimeError, match="changed during indexing"):
        index.reindex_cloud_video(1)
    assert not any(action.endswith("/publish") for action, _ in calls)


def test_deleted_source_is_skipped(monkeypatch):
    monkeypatch.setattr(index, "call_internal_api", lambda *args: {"source": None})
    assert index.reindex_cloud_video(1) == 0


def test_cloud_reindex_task_bypasses_postgres_lock(monkeypatch):
    from worker_python.tasks import reindex_video_transcript as task
    monkeypatch.setenv("PERSISTENCE_BACKEND", "d1")
    monkeypatch.setattr(task, "video_vector_write_lock", MagicMock(side_effect=AssertionError("PG lock")))
    run = MagicMock()
    monkeypatch.setattr(index, "reindex_cloud_video", run)
    task.reindex_video_transcript(1)
    run.assert_called_once_with(1)


def test_initial_index_resumes_pending_delivery_without_embedding(setup, monkeypatch):
    source, calls = setup
    source["status"] = "indexing"
    original = index.call_internal_api
    monkeypatch.setattr(index, "call_internal_api", lambda action, body:
        {"status": "pending"} if action.endswith("/finish") else original(action, body))
    embedding = MagicMock(side_effect=AssertionError("already published"))
    monkeypatch.setattr(index, "embed_texts", embedding)
    with pytest.raises(RuntimeError, match="delivery is pending"):
        index.reindex_cloud_video(1, finish_indexing=True)
    embedding.assert_not_called()
    assert [action for action, _ in calls] == ["scene-index/source"]


def test_initial_index_creates_once_then_finishes(setup, monkeypatch):
    source, calls = setup
    source["status"] = "indexing"
    original = index.call_internal_api
    statuses = iter(["missing", "completed"])
    monkeypatch.setattr(index, "call_internal_api", lambda action, body:
        {"status": next(statuses)} if action.endswith("/finish") else original(action, body))
    assert index.reindex_cloud_video(1, finish_indexing=True) == 43
    assert calls[-1][0] == "scene-index/publish"


def test_initial_empty_requires_explicit_flag(setup, monkeypatch):
    source, calls = setup
    source.update(status="indexing", transcript="")
    original = index.call_internal_api
    monkeypatch.setattr(index, "call_internal_api", lambda action, body:
        {"status": "missing"} if action.endswith("/finish") else original(action, body))
    with pytest.raises(ValueError, match="no transcript"):
        index.reindex_cloud_video(1, finish_indexing=True)
    assert not any(action.endswith("/start") for action, _ in calls)


def test_initial_task_uses_cloud_completion_path(monkeypatch):
    from worker_python.tasks import indexing as task
    monkeypatch.setenv("PERSISTENCE_BACKEND", "d1")
    monkeypatch.setattr(task, "video_vector_write_lock", MagicMock(side_effect=AssertionError("PG lock")))
    run = MagicMock()
    monkeypatch.setattr(index, "reindex_cloud_video", run)
    task.index_video_transcript(1, allow_empty=True)
    run.assert_called_once_with(1, finish_indexing=True, allow_empty=True)
    run.side_effect = RuntimeError("retry")
    with pytest.raises(task.IndexingExecutionFailedError):
        task.index_video_transcript(1)
