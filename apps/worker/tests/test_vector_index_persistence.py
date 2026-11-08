"""Replacing searchable scenes must be atomic and keep the shared SQL contract."""

import os
import time
import uuid
from dataclasses import replace
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from urllib.parse import urlsplit, urlunsplit

import psycopg
import pytest
from psycopg import sql
from psycopg.rows import dict_row

from worker_python.pipeline import vector_index
from worker_python.pipeline.embedding_contract import EmbeddingContractError
from worker_python.video_sql import VideoRow, finish_video_indexing
from worker_python.tasks import reindexing
from worker_python.advisory_locks import full_vector_write_lock


VECTOR = [1.0] + [0.0] * 1535
TRANSCRIPT = "1\n00:00:00,000 --> 00:00:01,000\nFirst\n\n2\n00:00:01,000 --> 00:00:02,000\nSecond"


def video(transcript=TRANSCRIPT):
    return VideoRow(
        id=12, user_id="owner", title="Lecture 'タイトル'", transcript=transcript,
        status="indexing", source_type="uploaded", file_key=None,
        youtube_video_id=None,
    )


@pytest.fixture
def database(monkeypatch):
    url = os.environ.get("DATABASE_URL")
    if not url:
        pytest.skip("DATABASE_URL is required for PostgreSQL integration tests")
    name = f"vector_write_{uuid.uuid4().hex}"
    with psycopg.connect(url, autocommit=True) as admin:
        if not admin.execute("SELECT 1 FROM pg_available_extensions WHERE name = 'vector'").fetchone():
            pytest.skip("pgvector is required for vector persistence tests")
        admin.execute(sql.SQL("CREATE DATABASE {}").format(sql.Identifier(name)))
        try:
            test_url = urlunsplit(urlsplit(url)._replace(path=f"/{name}"))
            monkeypatch.setenv("DATABASE_URL", test_url)
            monkeypatch.setenv("EMBEDDING_MODEL", "text-embedding-3-small")
            monkeypatch.setenv("PGVECTOR_COLLECTION_NAME", "scene_embeddings")
            monkeypatch.setattr(vector_index, "embed_texts", lambda texts: [VECTOR for _ in texts])
            # Transaction/race tests need multiple rows independent of grouping.
            # Real grouping and original-cue preservation are exercised separately.
            monkeypatch.setattr(vector_index, "apply_scene_splitting", lambda srt: srt)
            with psycopg.connect(test_url, autocommit=True, row_factory=dict_row) as conn:
                conn.execute("""
                    CREATE EXTENSION vector;
                    CREATE TABLE videos (
                        id bigint PRIMARY KEY, user_id text NOT NULL,
                        title text NOT NULL, transcript text
                    );
                    CREATE TABLE scene_embeddings (
                        langchain_id uuid PRIMARY KEY, content text NOT NULL,
                        embedding vector(1536) NOT NULL, user_id text NOT NULL,
                        video_id bigint NOT NULL, langchain_metadata json
                    );
                    CREATE TABLE vector_writes (transaction_id bigint, operation text);
                    CREATE FUNCTION record_write() RETURNS trigger LANGUAGE plpgsql AS $$
                    BEGIN
                        INSERT INTO vector_writes VALUES (txid_current(), TG_OP);
                        RETURN NULL;
                    END $$;
                """)
                for video_id, owner in [(12, "owner"), (13, "other"), (14, "owner")]:
                    conn.execute(
                        "INSERT INTO videos VALUES (%s, %s, %s, %s)",
                        (video_id, owner, video().title, TRANSCRIPT),
                    )
                    conn.execute("""
                        INSERT INTO scene_embeddings VALUES (%s, %s, %s::vector, %s, %s, %s)
                    """, (uuid.uuid4(), f"Original {video_id}", str(VECTOR), owner, video_id, '{"scene_index":1}'))
                conn.execute("""
                    CREATE TRIGGER record_write AFTER INSERT OR DELETE ON scene_embeddings
                        FOR EACH ROW EXECUTE FUNCTION record_write()
                """)
                yield conn
        finally:
            admin.execute(sql.SQL("DROP DATABASE {} WITH (FORCE)").format(sql.Identifier(name)))


def snapshot(conn):
    return conn.execute("""
        SELECT langchain_id::text, content, embedding::text, user_id,
               video_id, langchain_metadata FROM scene_embeddings ORDER BY langchain_id
    """).fetchall()


def test_scene_writes_commit_together_and_preserve_other_videos(database):
    before = snapshot(database)
    assert vector_index.index_video_transcript(video()) == 2
    rows = snapshot(database)
    assert [row for row in rows if row["video_id"] != 12] == [row for row in before if row["video_id"] != 12]
    contents = sorted(row["content"] for row in rows if row["video_id"] == 12)
    assert contents == ["First", "Second"]
    first = next(row for row in rows if row["content"] == "First")
    assert first["user_id"] == "owner"
    assert first["langchain_metadata"] == {
        "video_title": "Lecture 'タイトル'", "start_time": "00:00:00,000",
        "end_time": "00:00:01,000", "start_sec": 0.0, "end_sec": 1.0,
        "scene_index": 1,
    }
    writes = database.execute("SELECT * FROM vector_writes").fetchall()
    assert len(writes) == 3
    assert len({row["transaction_id"] for row in writes}) == 1


@pytest.mark.parametrize("deferred", [False, True])
def test_later_insert_or_commit_failure_rolls_back_all_changes(database, deferred):
    database.execute("""
        CREATE FUNCTION reject_second() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'injected insert failure'; END $$;
    """)
    trigger = "CONSTRAINT TRIGGER reject_second AFTER" if deferred else "TRIGGER reject_second BEFORE"
    timing = "DEFERRABLE INITIALLY DEFERRED" if deferred else ""
    database.execute(f"""
        CREATE {trigger} INSERT ON scene_embeddings {timing}
            FOR EACH ROW WHEN (NEW.content = 'Second') EXECUTE FUNCTION reject_second()
    """)
    before = snapshot(database)
    with pytest.raises(psycopg.errors.RaiseException, match="injected insert failure"):
        vector_index.index_video_transcript(video())
    assert snapshot(database) == before
    assert database.execute("SELECT * FROM vector_writes").fetchall() == []


@pytest.mark.parametrize("outcome", ["success", "provider", "missing-vector", "dimension"])
def test_embedding_batches_finish_before_writing_and_failures_preserve_scenes(database, monkeypatch, outcome):
    transcript = "\n\n".join(f"{i}\n00:00:00,000 --> 00:00:01,000\nScene {i}" for i in range(1, 66))
    database.execute("UPDATE videos SET transcript = %s WHERE id = 12", (transcript,))
    before = snapshot(database)
    batches = []
    active_connections = 0
    connect = vector_index.db_connection

    @contextmanager
    def connection():
        nonlocal active_connections
        with connect() as conn:
            active_connections += 1
            try:
                yield conn
            finally:
                active_connections -= 1

    def embed(texts):
        assert active_connections == 0
        assert snapshot(database) == before
        batches.append(texts)
        if len(batches) == 2:
            if outcome == "provider":
                raise RuntimeError("provider failed")
            if outcome == "missing-vector":
                return []
            if outcome == "dimension":
                return [[1.0]]
        return [VECTOR for _ in texts]

    monkeypatch.setattr(vector_index, "db_connection", connection)
    monkeypatch.setattr(vector_index, "embed_texts", embed)
    if outcome == "success":
        assert vector_index.index_video_transcript(video(transcript)) == 65
        rows = database.execute("""
            SELECT content, langchain_metadata->>'scene_index' AS index
              FROM scene_embeddings WHERE video_id = 12
             ORDER BY (langchain_metadata->>'scene_index')::integer
        """).fetchall()
        assert rows == [{"content": f"Scene {i}", "index": str(i)} for i in range(1, 66)]
        assert database.execute("SELECT count(DISTINCT transaction_id) AS count FROM vector_writes").fetchone()["count"] == 1
    else:
        error = {"provider": RuntimeError, "missing-vector": ValueError, "dimension": psycopg.DataError}[outcome]
        with pytest.raises(error):
            vector_index.index_video_transcript(video(transcript))
        assert snapshot(database) == before
        assert database.execute("SELECT * FROM vector_writes").fetchall() == []
    assert [len(batch) for batch in batches] == [64, 1]
    assert active_connections == 0


def test_schema_failure_preserves_scenes_without_calling_provider(database, monkeypatch):
    database.execute("ALTER TABLE scene_embeddings ALTER COLUMN embedding TYPE vector")
    before = snapshot(database)
    monkeypatch.setattr(vector_index, "embed_texts", lambda _: pytest.fail("Invalid schema must not call the provider"))
    with pytest.raises(EmbeddingContractError, match="vector\\(1536\\)"):
        vector_index.index_video_transcript(video())
    assert snapshot(database) == before
    assert database.execute("SELECT * FROM vector_writes").fetchall() == []


def test_readers_keep_original_scenes_until_replacement_commits(database):
    database.execute("""
        CREATE FUNCTION wait_for_reader() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN PERFORM pg_advisory_xact_lock(194633); RETURN NEW; END $$;
        CREATE TRIGGER wait_for_reader BEFORE INSERT ON scene_embeddings
            FOR EACH ROW WHEN (NEW.content = 'First') EXECUTE FUNCTION wait_for_reader();
    """)
    before = snapshot(database)
    database.execute("SELECT pg_advisory_lock(194633)")
    with ThreadPoolExecutor(max_workers=1) as executor:
        future = executor.submit(vector_index.index_video_transcript, video())
        try:
            deadline = time.monotonic() + 10
            while not database.execute("""
                SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND NOT granted
                    AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
            """).fetchone():
                assert not future.done(), "writer finished before reaching the blocked insert"
                assert time.monotonic() < deadline, "writer did not reach the blocked insert"
                time.sleep(0.01)
            assert snapshot(database) == before
            # API edits/deletion lock the video before touching its scenes.
            with pytest.raises(psycopg.errors.LockNotAvailable):
                database.execute("SELECT id FROM videos WHERE id = 12 FOR UPDATE NOWAIT")
        finally:
            database.execute("SELECT pg_advisory_unlock(194633)")
            assert future.result(timeout=10) == 2


@pytest.mark.parametrize("failure", ["provider", "transcript", "write"])
def test_full_reindex_keeps_failed_and_unvisited_scenes_and_retry_replaces_them(database, monkeypatch, failure):
    before = snapshot(database)
    good = video()
    bad = replace(good, id=14, transcript="1\n00:00:00,000 --> 00:00:01,000\nUnavailable")
    if failure == "provider":
        def embed(texts):
            if "Unavailable" in texts:
                raise RuntimeError("provider unavailable")
            return [VECTOR for _ in texts]
        monkeypatch.setattr(vector_index, "embed_texts", embed)
    elif failure == "transcript":
        bad = replace(bad, transcript="invalid transcript")
    else:
        database.execute("""
            CREATE FUNCTION reject_unavailable() RETURNS trigger LANGUAGE plpgsql AS $$
            BEGIN RAISE EXCEPTION 'write failed'; END $$;
            CREATE TRIGGER reject_unavailable BEFORE INSERT ON scene_embeddings
                FOR EACH ROW WHEN (NEW.content = 'Unavailable') EXECUTE FUNCTION reject_unavailable();
        """)

    database.execute("UPDATE videos SET transcript = %s WHERE id = 14", (bad.transcript,))
    with full_vector_write_lock(), pytest.raises(reindexing.ReindexingIncompleteError, match="1/2"):
        reindexing._run_reindex(iter([good, bad]))
    after = snapshot(database)
    assert [row for row in after if row["video_id"] != 12] == [row for row in before if row["video_id"] != 12]
    assert sorted(row["content"] for row in after if row["video_id"] == 12) == ["First", "Second"]

    database.execute("UPDATE videos SET transcript = %s WHERE id = 14", (good.transcript,))
    with full_vector_write_lock():
        reindexing._run_reindex(iter([good, replace(good, id=14)]))
    rows = snapshot(database)
    for video_id in [12, 14]:
        assert sorted(row["content"] for row in rows if row["video_id"] == video_id) == ["First", "Second"]
    assert [row for row in rows if row["video_id"] == 13] == [row for row in before if row["video_id"] == 13]


def test_video_deleted_during_embedding_is_not_recreated(database, monkeypatch):
    def embed(texts):
        # Match the API's transaction and lock order, independently of worker locks.
        with database.transaction():
            database.execute("SELECT id FROM videos WHERE id = 12 FOR UPDATE")
            database.execute("DELETE FROM scene_embeddings WHERE video_id = 12")
            database.execute("DELETE FROM videos WHERE id = 12")
        return [VECTOR for _ in texts]

    monkeypatch.setattr(vector_index, "embed_texts", embed)
    assert vector_index.index_video_transcript(video()) == 0
    assert database.execute("SELECT * FROM scene_embeddings WHERE video_id = 12").fetchall() == []
    assert len(snapshot(database)) == 2


def test_title_changed_during_embedding_is_preserved(database, monkeypatch):
    title = "Renamed during indexing"

    def embed(texts):
        with database.transaction():
            database.execute("UPDATE videos SET title = %s WHERE id = 12", (title,))
            database.execute("""
                UPDATE scene_embeddings
                   SET langchain_metadata = jsonb_set(langchain_metadata::jsonb, '{video_title}', to_jsonb(%s::text))
                 WHERE video_id = 12
            """, (title,))
        return [VECTOR for _ in texts]

    monkeypatch.setattr(vector_index, "embed_texts", embed)
    assert vector_index.index_video_transcript(video()) == 2
    titles = database.execute("""
        SELECT DISTINCT langchain_metadata->>'video_title' AS title
          FROM scene_embeddings WHERE video_id = 12
    """).fetchall()
    assert titles == [{"title": title}]


@pytest.mark.parametrize("transcript", ["", "1\n00:00:00,000 --> 00:00:01,000\nEdited"])
def test_transcript_changed_during_embedding_preserves_scenes_for_retry(database, monkeypatch, transcript):
    before = snapshot(database)

    def embed(texts):
        database.execute("UPDATE videos SET transcript = %s WHERE id = 12", (transcript,))
        return [VECTOR for _ in texts]

    monkeypatch.setattr(vector_index, "embed_texts", embed)
    with pytest.raises(ValueError, match="transcript changed during indexing"):
        vector_index.index_video_transcript(video())
    assert snapshot(database) == before
    assert database.execute("SELECT * FROM vector_writes").fetchall() == []
    if transcript:
        assert vector_index.index_video_transcript(video(transcript)) == 1
        assert [row["content"] for row in snapshot(database) if row["video_id"] == 12] == ["Edited"]


def test_manual_clear_removes_both_profiles_and_keeps_other_videos(database, monkeypatch):
    database.execute("CREATE TABLE scene_embeddings_768 (LIKE scene_embeddings INCLUDING ALL)")
    database.execute("INSERT INTO scene_embeddings_768 SELECT * FROM scene_embeddings")
    before = snapshot(database)
    database.execute("UPDATE videos SET transcript = '' WHERE id = 12")
    monkeypatch.setattr(vector_index, "embed_texts", lambda _: pytest.fail("Manual clear must not call the provider"))

    assert vector_index.clear_video_transcript_index(video("")) == 2

    assert snapshot(database) == [row for row in before if row["video_id"] != 12]
    assert database.execute("SELECT video_id FROM scene_embeddings_768 ORDER BY video_id").fetchall() == [
        {"video_id": 13}, {"video_id": 14},
    ]
    assert vector_index.clear_video_transcript_index(video("")) == 0


def test_manual_clear_rolls_back_first_profile_when_second_delete_fails(database):
    database.execute("CREATE TABLE scene_embeddings_768 (LIKE scene_embeddings INCLUDING ALL)")
    database.execute("INSERT INTO scene_embeddings_768 SELECT * FROM scene_embeddings")
    database.execute("""
        CREATE FUNCTION reject_clear() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'synthetic profile delete failure'; END $$;
        CREATE TRIGGER reject_clear BEFORE DELETE ON scene_embeddings_768
            FOR EACH ROW EXECUTE FUNCTION reject_clear();
    """)
    before = snapshot(database)
    database.execute("UPDATE videos SET transcript = '' WHERE id = 12")

    with pytest.raises(psycopg.errors.RaiseException, match="synthetic profile delete failure"):
        vector_index.clear_video_transcript_index(video(""))

    assert snapshot(database) == before
    assert database.execute("SELECT count(*) AS n FROM scene_embeddings_768").fetchone()["n"] == 3
    assert database.execute("SELECT * FROM vector_writes").fetchall() == []


def test_manual_clear_rejects_stale_text_and_wrong_owner(database):
    before = snapshot(database)
    with pytest.raises(ValueError, match="Transcript changed"):
        vector_index.clear_video_transcript_index(video(""))
    assert vector_index.clear_video_transcript_index(replace(video(""), user_id="other")) == 0
    assert snapshot(database) == before


@pytest.mark.parametrize("change", ["none", "transcript", "file", "owner", "status", "deleted"])
def test_completion_checks_the_indexed_source_snapshot(database, change):
    database.execute("""
        ALTER TABLE videos ADD COLUMN status text NOT NULL DEFAULT 'indexing',
            ADD COLUMN error_message text NOT NULL DEFAULT '', ADD COLUMN file text NOT NULL DEFAULT '';
    """)
    if change == "transcript":
        database.execute("UPDATE videos SET transcript = 'Later edit' WHERE id = 12")
    elif change == "file":
        database.execute("UPDATE videos SET file = 'new-source' WHERE id = 12")
    elif change == "owner":
        database.execute("UPDATE videos SET user_id = 'another' WHERE id = 12")
    elif change == "status":
        database.execute("UPDATE videos SET status = 'pending' WHERE id = 12")
    elif change == "deleted":
        database.execute("DELETE FROM videos WHERE id = 12")

    assert finish_video_indexing(database, video()) is (change == "none")
    row = database.execute("SELECT status FROM videos WHERE id = 12").fetchone()
    if row:
        assert row["status"] == {"none": "completed", "status": "pending"}.get(change, "indexing")
