from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
import os
from pathlib import Path
from unittest.mock import MagicMock
from uuid import uuid4

import psycopg
from psycopg import sql
from psycopg.rows import dict_row
import pytest

from worker_python import transcription_checkpoints as checkpoints
from worker_python.tasks import segmented_transcription as tasks
from worker_python.tasks import transcription
from worker_python.pipeline.transcription import NoAudioStreamError, NO_AUDIO_MESSAGE
from worker_python.video_sql import get_video_for_task


@pytest.fixture
def checkpoint_db(monkeypatch):
    url = os.environ.get("DATABASE_URL")
    if not url:
        pytest.skip("DATABASE_URL is required for PostgreSQL integration tests")
    monkeypatch.delenv("WHISPER_BACKEND", raising=False)
    monkeypatch.delenv("WHISPER_CHUNK_SECONDS", raising=False)
    schema = f"checkpoints_{uuid4().hex}"
    with psycopg.connect(url, autocommit=True) as admin:
        admin.execute(sql.SQL("CREATE SCHEMA {}").format(sql.Identifier(schema)))
        try:
            def connect():
                return psycopg.connect(url, options=f"-csearch_path={schema}", row_factory=dict_row)

            with connect() as conn:
                conn.execute("""
                    CREATE TABLE users (
                        id text PRIMARY KEY, processing_limit_minutes int,
                        used_processing_seconds int DEFAULT 0, used_ai_answers int DEFAULT 0,
                        usage_period_start timestamptz DEFAULT now(), is_over_quota bool DEFAULT false
                    );
                    CREATE TABLE videos (
                        id bigint PRIMARY KEY, user_id text REFERENCES users(id) ON DELETE CASCADE,
                        title text DEFAULT 'Video', transcript text, status text DEFAULT 'pending',
                        source_type text DEFAULT 'uploaded', file text DEFAULT 'video.mkv',
                        youtube_video_id text DEFAULT '', error_message text DEFAULT '',
                        processing_seconds int DEFAULT 0
                    );
                    INSERT INTO users (id) VALUES ('owner');
                    INSERT INTO videos (id, user_id) VALUES (42, 'owner');
                """)
                migration = Path(__file__).parents[2] / "api/drizzle/0031_resumable_transcription.sql"
                # Execute the generated production DDL in this isolated test schema.
                conn.execute(migration.read_text().replace('"public".', ''))
                language_migration = Path(__file__).parents[2] / "api/drizzle/0041_transcription_language.sql"
                conn.execute(language_migration.read_text())
                fallback_migration = Path(__file__).parents[2] / "api/drizzle/0037_resumable_transcription_fallback.sql"
                conn.execute(fallback_migration.read_text())
            for module in (checkpoints, tasks, transcription):
                monkeypatch.setattr(module, "db_connection", connect)
            monkeypatch.setenv("SQS_QUEUE_URL", "https://example.invalid/jobs")
            monkeypatch.setenv("VIDEO_VISUAL_ENABLED", "false")
            yield connect
        finally:
            admin.execute(sql.SQL("DROP SCHEMA {} CASCADE").format(sql.Identifier(schema)))


def video(connect):
    with connect() as conn:
        return get_video_for_task(conn, 42, include_transcript=False)


def test_concurrent_initialization_resumes_one_plan_and_reserves_quota_once(checkpoint_db):
    source = video(checkpoint_db)
    with ThreadPoolExecutor(max_workers=4) as pool:
        runs = list(pool.map(lambda _: checkpoints.initialize_run(source, 9289.617), range(4)))
    assert len({r.run_id for r in runs}) == 1
    assert runs[0].chunk_count == 31
    assert runs[0].duration_ms == 9289617
    assert checkpoints.pending_heads(runs[0]) == [0, 1, 2, 3]
    with checkpoint_db() as conn:
        assert conn.execute("SELECT used_processing_seconds FROM users").fetchone()["used_processing_seconds"] == 9290
        assert conn.execute("SELECT count(*) AS n FROM video_transcription_chunks").fetchone()["n"] == 31


def test_production_entry_initializes_lanes_without_transcribing_inline(checkpoint_db, monkeypatch):
    monkeypatch.setattr(transcription, "heavy_pipeline_enabled", lambda: True)
    monkeypatch.setattr(tasks, "_ffprobe_duration", lambda _: 9289.617)
    monkeypatch.setattr(tasks, "resolve_media_input", lambda key: key)
    monkeypatch.setattr(tasks, "ensure_audio_stream", lambda _: None)
    inline = MagicMock()
    monkeypatch.setattr(transcription, "run_transcription", inline)
    enqueue = MagicMock(return_value="message")
    monkeypatch.setattr(tasks, "enqueue_job", enqueue)
    transcription.transcribe_video(42, job_id="parent")
    transcription.transcribe_video(42, job_id="parent-retry")
    inline.assert_not_called()
    assert [call.args[1]["chunk_index"] for call in enqueue.call_args_list] == [0, 1, 2, 3] * 2
    assert [call.kwargs["job_id"] for call in enqueue.call_args_list[:4]] == [
        call.kwargs["job_id"] for call in enqueue.call_args_list[4:]
    ]


def test_video_without_audio_never_reserves_quota_or_enqueues(checkpoint_db, monkeypatch):
    monkeypatch.setattr(transcription, "heavy_pipeline_enabled", lambda: True)
    monkeypatch.setattr(tasks, "resolve_media_input", lambda key: key)
    monkeypatch.setattr(tasks, "ensure_audio_stream",
                        MagicMock(side_effect=NoAudioStreamError(NO_AUDIO_MESSAGE)))
    probe = MagicMock()
    enqueue = MagicMock()
    monkeypatch.setattr(tasks, "_ffprobe_duration", probe)
    monkeypatch.setattr(tasks, "enqueue_job", enqueue)
    transcription.transcribe_video(42, job_id="silent-parent")
    assert video(checkpoint_db).status == "error"
    with checkpoint_db() as conn:
        row = conn.execute("SELECT error_message FROM videos WHERE id = 42").fetchone()
        assert row["error_message"] == NO_AUDIO_MESSAGE
        assert conn.execute("SELECT used_processing_seconds FROM users").fetchone()["used_processing_seconds"] == 0
    assert checkpoints.load_run(42) is None
    probe.assert_not_called()
    enqueue.assert_not_called()


def test_existing_silent_plan_stops_all_lanes_without_sqs_retry(checkpoint_db, monkeypatch):
    run = checkpoints.initialize_run(video(checkpoint_db), 301)
    monkeypatch.setattr(tasks, "resolve_media_input", lambda key: key)
    monkeypatch.setattr(tasks, "ensure_audio_stream",
                        MagicMock(side_effect=NoAudioStreamError(NO_AUDIO_MESSAGE)))
    provider = MagicMock(side_effect=NoAudioStreamError(NO_AUDIO_MESSAGE))
    monkeypatch.setattr(tasks, "transcribe_audio_interval", provider)
    enqueue = MagicMock()
    monkeypatch.setattr(tasks, "enqueue_job", enqueue)
    tasks.transcribe_video_chunk(42, run.run_id, 0)
    tasks.transcribe_video_chunk(42, run.run_id, 1)
    assert provider.call_count == 1
    assert video(checkpoint_db).status == "error"
    assert checkpoints.load_run(42).completed
    with checkpoint_db() as conn:
        row = conn.execute("SELECT error_message FROM videos WHERE id = 42").fetchone()
        assert row["error_message"] == NO_AUDIO_MESSAGE
    enqueue.assert_not_called()


def test_missing_audio_in_one_interval_does_not_discard_valid_source(checkpoint_db, monkeypatch):
    run = checkpoints.initialize_run(video(checkpoint_db), 301)
    monkeypatch.setattr(tasks, "resolve_media_input", lambda key: key)
    monkeypatch.setattr(tasks, "ensure_audio_stream", lambda _: None)
    monkeypatch.setattr(tasks, "transcribe_audio_interval",
                        MagicMock(side_effect=NoAudioStreamError(NO_AUDIO_MESSAGE)))
    with pytest.raises(NoAudioStreamError):
        tasks.transcribe_video_chunk(42, run.run_id, 0)
    assert not checkpoints.load_run(42).completed
    with checkpoint_db() as conn:
        row = conn.execute("SELECT failures FROM video_transcription_chunks WHERE chunk_index = 0").fetchone()
        assert row["failures"] == 1


def test_completed_checkpoint_survives_failed_queue_handoff(checkpoint_db, monkeypatch):
    run = checkpoints.initialize_run(video(checkpoint_db), 1500)
    provider = MagicMock(return_value=[{"start": 0, "end": 1, "text": "first"}])
    monkeypatch.setattr(tasks, "transcribe_audio_interval", provider)
    monkeypatch.setattr(tasks, "resolve_media_input", lambda key: key)
    enqueue = MagicMock(side_effect=RuntimeError("queue unavailable"))
    monkeypatch.setattr(tasks, "enqueue_job", enqueue)
    with pytest.raises(RuntimeError, match="queue unavailable"):
        tasks.transcribe_video_chunk(42, run.run_id, 0)
    enqueue.side_effect = None
    enqueue.return_value = "message"
    tasks.transcribe_video_chunk(42, run.run_id, 0)
    provider.assert_called_once_with("video.mkv", 0, 300)
    assert enqueue.call_args.args[1]["chunk_index"] == 4
    with checkpoint_db() as conn:
        assert conn.execute("SELECT failures FROM video_transcription_chunks WHERE chunk_index = 0").fetchone()["failures"] == 0


def test_out_of_order_chunks_join_once_and_final_handoff_can_retry(checkpoint_db, monkeypatch):
    run = checkpoints.initialize_run(video(checkpoint_db), 9289.617)
    enqueue = MagicMock(return_value="message")
    monkeypatch.setattr(tasks, "enqueue_job", enqueue)
    monkeypatch.setattr(tasks, "resolve_media_input", lambda key: key)
    provider = MagicMock(side_effect=lambda source, start, duration: [
        {"start": start, "end": start + duration, "text": f"chunk {int(start / 300)}"},
    ])
    monkeypatch.setattr(tasks, "transcribe_audio_interval", provider)
    with pytest.raises(RuntimeError, match="incomplete"):
        tasks.finish_video_transcription(42, run.run_id)
    for index in reversed(range(run.chunk_count)):
        tasks.transcribe_video_chunk(42, run.run_id, index)
    assert provider.call_count == 31
    assert provider.call_args_list[0].args[1:] == (9000, pytest.approx(289.617))
    enqueue.side_effect = RuntimeError("final delivery lost")
    with pytest.raises(RuntimeError, match="final delivery lost"):
        tasks.finish_video_transcription(42, run.run_id)
    with checkpoint_db() as conn:
        saved = conn.execute("SELECT status, transcript FROM videos").fetchone()
    assert saved["status"] == "indexing"
    assert "02:34:49,617" in saved["transcript"]
    assert saved["transcript"].index("chunk 0") < saved["transcript"].index("chunk 30")
    assert checkpoints.load_run(42).completed
    enqueue.side_effect = None
    enqueue.return_value = "message"
    tasks.finish_video_transcription(42, run.run_id)
    tasks.transcribe_video_chunk(42, run.run_id, 30)
    assert provider.call_count == 31
    assert enqueue.call_args.args == ("index_video_transcript", {"video_id": 42})
    with checkpoint_db() as conn:
        assert conn.execute("SELECT transcript FROM videos").fetchone()["transcript"] == saved["transcript"]


@pytest.mark.parametrize("change", ["edit", "delete", "delete_account", "replace_source", "replace_run"])
def test_inflight_results_cannot_overwrite_changed_video(checkpoint_db, monkeypatch, change):
    run = checkpoints.initialize_run(video(checkpoint_db), 10)
    def generate(*_):
        with checkpoint_db() as conn:
            if change == "edit":
                conn.execute("UPDATE videos SET transcript = 'User edit', status = 'completed'")
            elif change == "delete":
                conn.execute("DELETE FROM videos")
            elif change == "delete_account":
                conn.execute("DELETE FROM users")
            elif change == "replace_source":
                conn.execute("UPDATE videos SET file = 'replacement.mkv'")
            else:
                conn.execute("DELETE FROM video_transcription_runs")
        if change == "replace_run":
            checkpoints.initialize_run(video(checkpoint_db), 20)
        return [{"start": 0, "end": 1, "text": "Discard this"}]
    monkeypatch.setattr(tasks, "resolve_media_input", lambda key: key)
    monkeypatch.setattr(tasks, "transcribe_audio_interval", generate)
    enqueue = MagicMock(return_value="message")
    monkeypatch.setattr(tasks, "enqueue_job", enqueue)
    tasks.transcribe_video_chunk(42, run.run_id, 0)
    tasks.finish_video_transcription(42, run.run_id)
    enqueue.assert_not_called()
    with checkpoint_db() as conn:
        assert conn.execute("SELECT count(*) AS n FROM video_transcription_chunks WHERE segments IS NOT NULL").fetchone()["n"] == 0
        if change in {"delete", "delete_account"}:
            assert conn.execute("SELECT count(*) AS n FROM video_transcription_runs").fetchone()["n"] == 0
        elif change == "edit":
            assert conn.execute("SELECT transcript FROM videos").fetchone()["transcript"] == "User edit"


def test_failed_chunk_resumes_and_silent_chunk_is_a_completed_checkpoint(checkpoint_db, monkeypatch):
    run = checkpoints.initialize_run(video(checkpoint_db), 301)
    monkeypatch.setattr(tasks, "resolve_media_input", lambda key: key)
    provider = MagicMock(side_effect=RuntimeError("ASR unavailable"))
    monkeypatch.setattr(tasks, "transcribe_audio_interval", provider)
    monkeypatch.setattr(tasks, "enqueue_job", lambda *a, **kw: "message")
    for _ in range(5):
        with pytest.raises(RuntimeError, match="ASR unavailable"):
            tasks.transcribe_video_chunk(42, run.run_id, 0)
    assert video(checkpoint_db).status == "error"
    assert checkpoints.initialize_run(video(checkpoint_db), 301).run_id == run.run_id
    provider.side_effect = None
    provider.return_value = []
    tasks.transcribe_video_chunk(42, run.run_id, 0)
    tasks.transcribe_video_chunk(42, run.run_id, 0)
    assert provider.call_count == 6
    provider.return_value = [{"start": 300, "end": 301, "text": "last second"}]
    tasks.transcribe_video_chunk(42, run.run_id, 1)
    tasks.finish_video_transcription(42, run.run_id)
    assert video(checkpoint_db).status == "indexing"


def test_quota_failure_never_enqueues_or_creates_a_plan(checkpoint_db, monkeypatch):
    with checkpoint_db() as conn:
        conn.execute("UPDATE users SET processing_limit_minutes = 1")
    monkeypatch.setattr(transcription, "heavy_pipeline_enabled", lambda: True)
    monkeypatch.setattr(tasks, "_ffprobe_duration", lambda _: 9289.617)
    monkeypatch.setattr(tasks, "resolve_media_input", lambda key: key)
    monkeypatch.setattr(tasks, "ensure_audio_stream", lambda _: None)
    enqueue = MagicMock()
    monkeypatch.setattr(tasks, "enqueue_job", enqueue)
    transcription.transcribe_video(42)
    assert video(checkpoint_db).status == "error"
    assert checkpoints.load_run(42) is None
    enqueue.assert_not_called()


def test_all_silent_plan_ends_in_error_and_user_retry_can_start_again(checkpoint_db, monkeypatch):
    run = checkpoints.initialize_run(video(checkpoint_db), 10)
    checkpoints.save_chunk(run, 0, [])
    enqueue = MagicMock()
    monkeypatch.setattr(tasks, "enqueue_job", enqueue)
    tasks.finish_video_transcription(42, run.run_id)
    tasks.finish_video_transcription(42, run.run_id)
    assert video(checkpoint_db).status == "error"
    assert checkpoints.load_run(42).completed
    enqueue.assert_not_called()
    assert checkpoints.initialize_run(video(checkpoint_db), 10).run_id != run.run_id


def test_cpu_profile_uses_shorter_checkpoints_and_still_reserves_usage_once(checkpoint_db, monkeypatch):
    monkeypatch.setenv("WHISPER_CHUNK_SECONDS", "30")
    run = checkpoints.initialize_run(video(checkpoint_db), 618.74)
    assert (run.chunk_seconds, run.chunk_count) == (30, 21)
    monkeypatch.setenv("WHISPER_CHUNK_SECONDS", "300")
    resumed = checkpoints.initialize_run(video(checkpoint_db), 618.74)
    assert resumed.run_id == run.run_id
    assert (resumed.chunk_seconds, resumed.chunk_count) == (30, 21)
    with checkpoint_db() as conn:
        assert conn.execute("SELECT used_processing_seconds FROM users").fetchone()["used_processing_seconds"] == 619


@pytest.mark.parametrize("value", ["0", "29", "301", "1.5", "typo"])
def test_invalid_interval_config_fails_before_reserving_quota(monkeypatch, value):
    monkeypatch.setenv("WHISPER_CHUNK_SECONDS", value)
    with pytest.raises(ValueError, match="WHISPER_CHUNK_SECONDS"):
        checkpoints.configured_chunk_seconds()


def test_short_cpu_intervals_cannot_exceed_the_queue_checkpoint_contract(monkeypatch):
    monkeypatch.setenv("WHISPER_CHUNK_SECONDS", "30")
    def connect():
        pytest.fail("An oversized plan must fail before database access or quota reservation")
    monkeypatch.setattr(checkpoints, "db_connection", connect)
    source = MagicMock(file_key="video.mp4", transcript_hash="fingerprint")
    with pytest.raises(ValueError, match="10,000-checkpoint"):
        checkpoints.initialize_run(source, 300001)


def test_saved_video_language_is_reused_for_every_chunk_and_retry(checkpoint_db, monkeypatch):
    with checkpoint_db() as conn:
        conn.execute("UPDATE videos SET transcription_language = 'ja' WHERE id = 42")
    run = checkpoints.initialize_run(video(checkpoint_db), 601)
    provider = MagicMock(side_effect=[RuntimeError("temporary failure"), [], [], []])
    monkeypatch.setattr(tasks, "transcribe_audio_interval", provider)
    monkeypatch.setattr(tasks, "resolve_media_input", lambda key: key)
    monkeypatch.setattr(tasks, "enqueue_job", MagicMock(return_value="message"))
    with pytest.raises(RuntimeError, match="temporary failure"):
        tasks.transcribe_video_chunk(42, run.run_id, 0)
    for index in range(3):
        tasks.transcribe_video_chunk(42, run.run_id, index)
    assert len(provider.call_args_list) == 4
    assert all(call.kwargs == {"language": "ja"} for call in provider.call_args_list)
