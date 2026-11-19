"""The operator backfill must work with cloud persistence without PostgreSQL."""
from contextlib import contextmanager
from dataclasses import replace
from types import SimpleNamespace
from unittest.mock import Mock

import pytest
from worker_python.visual_checkpoints import VisualRun

from worker_python.tasks import visual_preparation as script


@pytest.fixture
def setup(monkeypatch):
    run = VisualRun(42, "run-42", "private/lesson.mp4", 62000, 2, "processing")
    source = {"videoId": 42, "sourceType": "uploaded", "fileKey": run.file_key, "status": "completed"}
    api = Mock(return_value={"source": source})
    monkeypatch.setattr(script, "uses_internal_persistence", lambda: True)
    monkeypatch.setattr(script, "call_internal_api", api)
    monkeypatch.setattr(script, "db_connection", Mock(side_effect=AssertionError("Cloud backfill must not open PostgreSQL")))
    probe = Mock(return_value=62)
    monkeypatch.setattr(script, "resolve_media_input", lambda key: "local-fixture")
    monkeypatch.setattr(script, "_ffprobe_duration", probe)
    initialize = Mock(return_value=run)
    monkeypatch.setattr(script.visual_checkpoints, "initialize", initialize)
    monkeypatch.setattr(script.visual_checkpoints, "load_run", Mock(return_value=None))
    dispatch, build, finish = Mock(), Mock(), Mock()
    monkeypatch.setattr(script, "dispatch", dispatch)
    monkeypatch.setattr(script, "build_video_visual_chunk", build)
    monkeypatch.setattr(script, "finish_video_visuals", finish)
    monkeypatch.setenv("SQS_QUEUE_URL", "https://queue.example/fixture")
    return SimpleNamespace(run=run, source=source, api=api, probe=probe, initialize=initialize, dispatch=dispatch, build=build, finish=finish)


def test_cloud_backfill_queues_only_visual_work(setup):
    assert script.prepare_visuals(42) == {"video_id": 42, "visual_preparation": "queued", "chunks": 2}
    setup.api.assert_called_once_with("transcription/source", {"videoId": 42})
    setup.initialize.assert_called_once_with(42, setup.run.file_key, 62)
    setup.dispatch.assert_called_once_with(setup.run)
    setup.build.assert_not_called()


def test_cloud_backfill_can_complete_synchronously(monkeypatch, setup):
    monkeypatch.delenv("SQS_QUEUE_URL")
    monkeypatch.setattr(script.visual_checkpoints, "load_run", Mock(side_effect=[None, replace(setup.run, status="ready")]))
    assert script.prepare_visuals(42)["visual_preparation"] == "ready"
    assert setup.build.call_args_list == [((42, "run-42", 0), {"dispatch_next": False}), ((42, "run-42", 1), {"dispatch_next": False})]
    setup.finish.assert_called_once_with(42, "run-42")


def test_source_change_cannot_be_reported_ready(monkeypatch, setup):
    monkeypatch.delenv("SQS_QUEUE_URL")
    with pytest.raises(RuntimeError, match="did not become ready"):
        script.prepare_visuals(42)


def test_dry_run_never_initializes_or_queues(setup):
    assert script.prepare_visuals(42, dry_run=True)["visual_preparation"] == "dry_run"
    setup.initialize.assert_not_called()
    setup.dispatch.assert_not_called()


@pytest.mark.parametrize("patch", [{"sourceType": "youtube"}, {"fileKey": ""}, {"status": "processing"}, {"videoId": 99}])
def test_invalid_sources_do_not_access_media(setup, patch):
    setup.api.return_value = {"source": {**setup.source, **patch}}
    with pytest.raises(ValueError):
        script.prepare_visuals(42)
    setup.probe.assert_not_called()
    setup.initialize.assert_not_called()


def test_ready_cache_does_not_reprocess_media(monkeypatch, setup):
    monkeypatch.setattr(script.visual_checkpoints, "load_run", Mock(return_value=replace(setup.run, status="ready")))
    assert script.prepare_visuals(42)["visual_preparation"] == "ready"
    setup.probe.assert_not_called()
    setup.dispatch.assert_not_called()


def test_onprem_still_uses_metadata_only_postgres(monkeypatch, setup):
    monkeypatch.setattr(script, "uses_internal_persistence", lambda: False)
    @contextmanager
    def connection():
        yield "postgres-connection"
    monkeypatch.setattr(script, "db_connection", connection)
    load = Mock(return_value=SimpleNamespace(source_type="uploaded", file_key=setup.run.file_key, status="completed"))
    monkeypatch.setattr(script, "get_video_for_task", load)
    assert script.prepare_visuals(42)["visual_preparation"] == "queued"
    load.assert_called_once_with("postgres-connection", 42, include_transcript=False)
    setup.api.assert_not_called()
