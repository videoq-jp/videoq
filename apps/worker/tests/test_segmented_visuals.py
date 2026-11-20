from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
import json
import os
from pathlib import Path
from unittest.mock import MagicMock
from uuid import uuid4

import psycopg
from psycopg import sql
from psycopg.rows import dict_row
import pytest

from worker_python import visual_checkpoints as checkpoints
from worker_python.tasks import segmented_visuals as tasks
from worker_python.pipeline.visual_chunks import chunk_key, manifest_key


@pytest.fixture
def visual_db(monkeypatch, tmp_path):
    url = os.environ.get('DATABASE_URL')
    if not url:
        pytest.skip('DATABASE_URL required for PostgreSQL tests')
    schema = f'visual_{uuid4().hex}'
    with psycopg.connect(url, autocommit=True) as admin:
        admin.execute(sql.SQL('CREATE SCHEMA {}').format(sql.Identifier(schema)))
        try:
            def connect():
                return psycopg.connect(url, options=f'-csearch_path={schema}', row_factory=dict_row)
            with connect() as conn:
                conn.execute("""CREATE TABLE videos (id bigint PRIMARY KEY, file text, source_type text,
                    status text DEFAULT 'completed', transcript text DEFAULT 'Original transcript');
                    INSERT INTO videos (id, file, source_type) VALUES (42, 'video.mkv', 'uploaded');""")
                migration = Path(__file__).parents[2] / 'api/drizzle/0032_segmented_visuals.sql'
                conn.execute(migration.read_text().replace('"public".', ''))
            for module in (checkpoints, tasks):
                monkeypatch.setattr(module, 'db_connection', connect)
            monkeypatch.setenv('USE_S3_STORAGE', 'false')
            monkeypatch.setenv('MEDIA_ROOT', str(tmp_path))
            (tmp_path / 'video.mkv').write_bytes(b'test source')
            monkeypatch.setattr(tasks, 'enqueue_job', MagicMock(return_value='message'))
            @contextmanager
            def build(source, video_id, duration, index):
                pack = tmp_path / 'test-pack'
                pack.write_bytes(b'fake bounded pack')
                yield pack, json.dumps([{'timestamp_seconds': index * 60, 'jpeg_base64': '/9j/2Q==', 'offset': 123, 'length': 4}]).encode(), 1
            monkeypatch.setattr(tasks, 'build_visual_chunk', MagicMock(side_effect=build))
            yield connect, tmp_path
        finally:
            admin.execute(sql.SQL('DROP SCHEMA {} CASCADE').format(sql.Identifier(schema)))


def test_same_source_initializes_once_and_fans_out_all_long_video_chunks(visual_db):
    with ThreadPoolExecutor(max_workers=4) as pool:
        runs = list(pool.map(lambda _: checkpoints.initialize(42, 'video.mkv', 9289.617), range(4)))
    assert len({run.run_id for run in runs}) == 1
    assert runs[0].chunk_count == 155
    assert checkpoints.pending_chunks(runs[0]) == list(range(155))
    tasks.dispatch(runs[0])
    calls = tasks.enqueue_job.call_args_list
    assert [call.args[1]['chunk_index'] for call in calls] == list(range(155))
    assert len({call.kwargs['job_id'] for call in calls}) == 155


def test_saved_chunk_survives_queue_failure_without_decoding_again(visual_db):
    run = checkpoints.initialize(42, 'video.mkv', 5)
    tasks.enqueue_job.side_effect = RuntimeError('Queue unavailable')
    with pytest.raises(RuntimeError, match='Queue unavailable'):
        tasks.build_video_visual_chunk(42, run.run_id, 0)
    assert checkpoints.chunk_complete(run, 0)
    tasks.enqueue_job.side_effect = None
    tasks.build_video_visual_chunk(42, run.run_id, 0)
    tasks.build_visual_chunk.assert_called_once()
    assert tasks.enqueue_job.call_args.args[0] == tasks.JOB_FINISH_VIDEO_VISUALS


def test_fanout_retry_only_schedules_unsaved_chunks_with_stable_ids(visual_db):
    run = checkpoints.initialize(42, 'video.mkv', 181)
    tasks.build_video_visual_chunk(42, run.run_id, 0)
    tasks.enqueue_job.assert_not_called()
    tasks.enqueue_job.side_effect = ['message', RuntimeError('Queue unavailable')]
    with pytest.raises(RuntimeError, match='Queue unavailable'):
        tasks.start_visuals(42, 'video.mkv', 181)
    first_job_id = tasks.enqueue_job.call_args_list[0].kwargs['job_id']
    tasks.enqueue_job.reset_mock(side_effect=True)
    tasks.start_visuals(42, 'video.mkv', 181)
    calls = tasks.enqueue_job.call_args_list
    assert [call.args[1]['chunk_index'] for call in calls] == [1, 2, 3]
    assert calls[0].kwargs['job_id'] == first_job_id
    tasks.build_visual_chunk.assert_called_once()


def test_out_of_order_completion_publishes_both_caches_only_after_every_chunk(visual_db):
    connect, root = visual_db
    run = checkpoints.initialize(42, 'video.mkv', 125.4)
    with pytest.raises(RuntimeError, match='incomplete'):
        tasks.finish_video_visuals(42, run.run_id)
    assert not (root / manifest_key('video.mkv')).exists()
    for index in [2, 0]:
        tasks.build_video_visual_chunk(42, run.run_id, index)
        tasks.enqueue_job.assert_not_called()
    tasks.build_video_visual_chunk(42, run.run_id, 1)
    assert tasks.enqueue_job.call_count == 1
    assert tasks.enqueue_job.call_args.args[0] == tasks.JOB_FINISH_VIDEO_VISUALS
    tasks.finish_video_visuals(42, run.run_id)
    tasks.finish_video_visuals(42, run.run_id)
    assert checkpoints.load_run(42).status == 'ready'
    manifest = json.loads((root / manifest_key('video.mkv')).read_bytes())
    assert manifest['chunk_count'] == 3
    assert [frame[0] for frame in manifest['overview']] == [0, 60000, 120000]
    assert len(json.loads((root / 'video.mkv.frames-v1.json').read_bytes())['frames']) == 3
    with connect() as conn:
        row = conn.execute('SELECT status, transcript FROM videos').fetchone()
        assert row == {'status': 'completed', 'transcript': 'Original transcript'}


def test_decode_failure_is_visible_without_losing_transcript_and_can_retry(visual_db):
    run = checkpoints.initialize(42, 'video.mkv', 5)
    builder = tasks.build_visual_chunk.side_effect
    tasks.build_visual_chunk.side_effect = RuntimeError('Extraction failed (signal SIGKILL): https://media.invalid?private=1')
    with pytest.raises(RuntimeError, match='SIGKILL'):
        tasks.build_video_visual_chunk(42, run.run_id, 0)
    assert checkpoints.load_run(42).status == 'error'
    with visual_db[0]() as conn:
        row = conn.execute('SELECT failures, last_error FROM video_visual_chunks').fetchone()
        assert row['failures'] == 1 and 'SIGKILL' in row['last_error'] and 'private' not in row['last_error']
        assert conn.execute('SELECT transcript FROM videos').fetchone()['transcript'] == 'Original transcript'
    tasks.build_visual_chunk.side_effect = builder
    tasks.build_video_visual_chunk(42, run.run_id, 0)
    tasks.finish_video_visuals(42, run.run_id)
    assert checkpoints.load_run(42).status == 'ready'


@pytest.mark.parametrize('change', ['delete', 'replace'])
def test_stale_decoder_cannot_publish_after_video_deletion_or_source_change(visual_db, change):
    connect, root = visual_db
    run = checkpoints.initialize(42, 'video.mkv', 5)
    builder = tasks.build_visual_chunk.side_effect
    @contextmanager
    def change_source(*args):
        with builder(*args) as result:
            with connect() as conn:
                conn.execute('DELETE FROM videos' if change == 'delete' else "UPDATE videos SET file = 'new.mkv'")
            yield result
    tasks.build_visual_chunk.side_effect = change_source
    tasks.build_video_visual_chunk(42, run.run_id, 0)
    assert not (root / chunk_key('video.mkv', run.run_id, 0)).exists()
    tasks.enqueue_job.assert_not_called()


def test_failed_manifest_publication_can_retry_without_regenerating_chunks(visual_db, monkeypatch):
    run = checkpoints.initialize(42, 'video.mkv', 5)
    tasks.build_video_visual_chunk(42, run.run_id, 0)
    original = tasks.upload_bytes
    def fail_manifest(key, *args):
        if key.endswith('.focus-v2.json'):
            raise RuntimeError('storage unavailable')
        original(key, *args)
    monkeypatch.setattr(tasks, 'upload_bytes', fail_manifest)
    with pytest.raises(RuntimeError, match='storage unavailable'):
        tasks.finish_video_visuals(42, run.run_id)
    assert checkpoints.load_run(42).status == 'error'
    monkeypatch.setattr(tasks, 'upload_bytes', original)
    tasks.finish_video_visuals(42, run.run_id)
    assert checkpoints.load_run(42).status == 'ready'
    tasks.build_visual_chunk.assert_called_once()


def test_successful_chunk_keeps_other_chunk_failure_until_that_chunk_recovers(visual_db):
    run = checkpoints.initialize(42, 'video.mkv', 61)
    checkpoints.record_failure(run, 'first failed', 0)
    checkpoints.record_failure(run, 'second failed', 1)
    tasks.build_video_visual_chunk(42, run.run_id, 0)
    with visual_db[0]() as conn:
        state = conn.execute('SELECT status, last_error FROM video_visual_runs').fetchone()
        chunks = conn.execute('SELECT frame_count, last_error FROM video_visual_chunks ORDER BY chunk_index').fetchall()
    assert state == {'status': 'error', 'last_error': 'second failed'}
    assert chunks == [{'frame_count': 1, 'last_error': ''}, {'frame_count': None, 'last_error': 'second failed'}]
    tasks.build_video_visual_chunk(42, run.run_id, 1)
    with visual_db[0]() as conn:
        assert conn.execute('SELECT status, last_error FROM video_visual_runs').fetchone() == {'status': 'processing', 'last_error': ''}


def test_failed_object_put_cannot_commit_chunk_success(visual_db, monkeypatch):
    run = checkpoints.initialize(42, 'video.mkv', 5)
    original = tasks.upload_bytes
    monkeypatch.setattr(tasks, 'upload_bytes', MagicMock(side_effect=RuntimeError('PUT failed')))
    with pytest.raises(RuntimeError, match='PUT failed'):
        tasks.build_video_visual_chunk(42, run.run_id, 0)
    assert checkpoints.chunk_complete(run, 0) is False
    monkeypatch.setattr(tasks, 'upload_bytes', original)
    tasks.build_video_visual_chunk(42, run.run_id, 0)
    assert checkpoints.chunk_complete(run, 0) is True
