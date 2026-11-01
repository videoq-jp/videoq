from __future__ import annotations

import os
import uuid
from unittest.mock import MagicMock

import psycopg
import pytest
from psycopg import sql
from psycopg.rows import dict_row

from worker_python.tasks import transcription

ORIGINAL = "1\n00:00:00,000 --> 00:00:01,000\nOriginal"
GENERATED = "1\n00:00:00,000 --> 00:00:01,000\nGenerated"
EDITED = "1\n00:00:00,000 --> 00:00:01,000\nUser correction"


@pytest.fixture
def transcription_db(monkeypatch):
    database_url = os.environ.get("DATABASE_URL")
    if not database_url:
        pytest.skip("DATABASE_URL is required for PostgreSQL integration tests")
    schema = f"transcription_{uuid.uuid4().hex}"
    with psycopg.connect(database_url, autocommit=True) as admin:
        admin.execute(sql.SQL("CREATE SCHEMA {}").format(sql.Identifier(schema)))
        try:
            admin.execute(sql.SQL("""
                CREATE TABLE {}.videos (
                    id bigint PRIMARY KEY, user_id text, title text, transcript text,
                    status text, source_type text, file text, youtube_video_id text,
                    error_message text DEFAULT '', transcription_language varchar(3)
                )
            """).format(sql.Identifier(schema)))

            def connect():
                return psycopg.connect(database_url, options=f"-csearch_path={schema}", row_factory=dict_row)

            with connect() as conn:
                conn.execute("""
                    INSERT INTO videos (id, user_id, title, transcript, status, source_type, file, youtube_video_id, error_message) VALUES
                        (42, 'owner', 'Video', %s, 'processing', 'uploaded', 'video.mp4', '', '')
                """, (ORIGINAL,))
            monkeypatch.setattr(transcription, "db_connection", connect)
            yield connect
        finally:
            admin.execute(sql.SQL("DROP SCHEMA {} CASCADE").format(sql.Identifier(schema)))


@pytest.mark.parametrize("failure", [None, "provider", "quota"])
@pytest.mark.parametrize("change", ["none", "edited", "cleared", "deleted", "superseded", "handoff", "metadata"])
def test_transcription_completion_preserves_concurrent_changes(transcription_db, monkeypatch, change, failure):
    def generate(*_args, **_kwargs):
        with transcription_db() as conn:
            if change in ("edited", "cleared"):
                conn.execute("UPDATE videos SET transcript = %s WHERE id = 42", (EDITED if change == "edited" else "",))
            elif change == "deleted":
                conn.execute("DELETE FROM videos WHERE id = 42")
            elif change in ("superseded", "handoff"):
                conn.execute("UPDATE videos SET transcript = %s, status = %s WHERE id = 42",
                             (EDITED, "completed" if change == "superseded" else "indexing"))
            elif change == "metadata":
                conn.execute("UPDATE videos SET title = 'Edited title' WHERE id = 42")
        if failure == "provider":
            raise RuntimeError("Provider unavailable")
        if failure == "quota":
            raise transcription.ProcessingQuotaExceededError("Quota exceeded")
        return GENERATED

    provider = MagicMock(side_effect=generate)
    enqueue = MagicMock()
    monkeypatch.setattr(transcription, "run_transcription", provider)
    monkeypatch.setattr(transcription, "_enqueue_or_run_indexing", enqueue)
    if change in ("none", "metadata") and failure == "provider":
        with pytest.raises(transcription.TranscriptionExecutionFailedError, match="Provider unavailable"):
            transcription.transcribe_video(42, job_id="transcribe-job")
    else:
        transcription.transcribe_video(42, job_id="transcribe-job")
    provider.assert_called_once()
    with transcription_db() as conn:
        row = conn.execute("SELECT transcript, status FROM videos WHERE id = 42").fetchone()
        if change == "metadata":
            assert conn.execute("SELECT title FROM videos WHERE id = 42").fetchone()["title"] == "Edited title"
        if change in ("none", "metadata") and failure:
            assert conn.execute("SELECT error_message FROM videos WHERE id = 42").fetchone()["error_message"]
    if change in ("none", "metadata"):
        assert row == {"transcript": ORIGINAL if failure else GENERATED, "status": "error" if failure else "indexing"}
        if failure:
            enqueue.assert_not_called()
        else:
            enqueue.assert_called_once_with(42, "transcribe-job")
    elif change == "handoff":
        assert row == {"transcript": EDITED, "status": "indexing"}
        enqueue.assert_called_once_with(42, "transcribe-job")
    else:
        assert row == (None if change == "deleted" else {
            "transcript": "" if change == "cleared" else EDITED,
            "status": "completed",
        })
        # API edits already enqueue their own reindex atomically. Do not replace
        # that work with another paid indexing job for a discarded transcript.
        enqueue.assert_not_called()


@pytest.mark.parametrize("original", [None, ""])
def test_first_transcription_persists_subtitles_and_schedules_indexing(transcription_db, monkeypatch, original):
    with transcription_db() as conn:
        conn.execute("UPDATE videos SET transcript = %s, status = 'pending' WHERE id = 42", (original,))
    monkeypatch.setattr(transcription, "run_transcription", MagicMock(return_value=GENERATED))
    enqueue = MagicMock()
    monkeypatch.setattr(transcription, "_enqueue_or_run_indexing", enqueue)
    transcription.transcribe_video(42, job_id="transcribe-job")
    with transcription_db() as conn:
        assert conn.execute("SELECT transcript, status FROM videos WHERE id = 42").fetchone() == {
            "transcript": GENERATED, "status": "indexing",
        }
    enqueue.assert_called_once_with(42, "transcribe-job")
