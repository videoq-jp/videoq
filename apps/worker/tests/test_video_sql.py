from __future__ import annotations

import json
import os

import psycopg
import pytest
from psycopg.rows import dict_row

from worker_python.video_sql import _row_to_video, get_video_for_task


def _row(**overrides) -> dict:
    row = {
        "id": 109,
        # users.id became a UUID text PK in migration 0006_user_id_uuid.
        "user_id": "1f0c6a5e-6d3c-4a1b-9f2e-8c7d5b4a3e21",
        "title": "sample",
        "transcript": None,
        "status": "uploaded",
        "source_type": "uploaded",
        "file": "videos/109.mp4",
        "youtube_video_id": None,
    }
    row.update(overrides)
    return row


def test_row_to_video_keeps_uuid_user_id_as_text() -> None:
    video = _row_to_video(_row())

    assert video.user_id == "1f0c6a5e-6d3c-4a1b-9f2e-8c7d5b4a3e21"
    assert video.id == 109


def test_row_to_video_normalises_optional_columns() -> None:
    video = _row_to_video(_row(file="", transcript=""))

    assert video.file_key is None
    assert video.transcript is None


@pytest.fixture
def video_db():
    database_url = os.environ.get("DATABASE_URL")
    if not database_url:
        pytest.skip("DATABASE_URL is required for PostgreSQL integration tests")
    returned_rows = []

    class RecordingCursor(psycopg.Cursor):
        def fetchone(self):
            row = super().fetchone()
            returned_rows.append(row)
            return row

    with psycopg.connect(
        database_url, row_factory=dict_row, cursor_factory=RecordingCursor
    ) as conn:
        conn.execute("""
            CREATE TEMP TABLE videos (
                id bigint PRIMARY KEY, user_id text, title text, transcript text,
                status text, source_type text, file text, youtube_video_id text,
                transcription_language varchar(3)
            )
        """)
        yield conn, returned_rows
        conn.rollback()


@pytest.mark.parametrize("status", ["pending", "processing", "indexing", "completed", "error"])
def test_task_metadata_does_not_transfer_existing_transcript(video_db, status):
    conn, returned_rows = video_db
    transcript = "既存の長い字幕😀\n" * 100_000
    conn.execute(
        """
        INSERT INTO videos
            (id, user_id, title, transcript, status, source_type, file, youtube_video_id, transcription_language)
        VALUES (109, 'owner', 'Title', %s, %s, 'youtube', NULL, 'abcdefghijk', 'ja')
        """,
        (transcript, status),
    )

    video = get_video_for_task(conn, 109, include_transcript=False)

    assert video is not None
    assert video.transcript is None
    assert video.transcription_language == "ja"
    assert (video.id, video.user_id, video.title, video.status) == (109, "owner", "Title", status)
    assert (video.source_type, video.file_key, video.youtube_video_id) == ("youtube", None, "abcdefghijk")
    # Inspect the actual database response, before the row mapper can drop data.
    assert len(returned_rows) == 1
    assert returned_rows[0]["transcript"] is None
    assert len(json.dumps(returned_rows[0], ensure_ascii=False)) < 1024

    # Indexing still needs the complete transcript, including Unicode and newlines.
    assert get_video_for_task(conn, 109).transcript == transcript


@pytest.mark.parametrize("include_transcript", [False, True])
def test_task_read_preserves_missing_video(video_db, include_transcript):
    conn, _ = video_db
    assert get_video_for_task(conn, 999, include_transcript=include_transcript) is None
