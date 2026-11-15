"""Bounded visual decoding with durable checkpoints and atomic readiness."""

import logging

from worker_python import visual_checkpoints as checkpoints
from worker_python.contracts import JOB_BUILD_VIDEO_VISUAL_CHUNK, JOB_FINISH_VIDEO_VISUALS
from worker_python.db import db_connection
from worker_python.internal_api import uses_internal_persistence
from worker_python.pipeline.visual_publication import publication_payloads
from worker_python.pipeline.media_process import _redact_urls
from worker_python.pipeline.storage import resolve_media_input, upload_file, upload_bytes
from worker_python.pipeline.visual_chunks import build_visual_chunk, chunk_key, manifest_key
from worker_python.pipeline.visual_frames import frame_cache_key
from worker_python.sqs_enqueue import child_job_id, enqueue_job

logger = logging.getLogger(__name__)


def _send(run, kind, **extra):
    payload = {'video_id': run.video_id, 'run_id': run.run_id, **extra}
    if not enqueue_job(kind, payload, job_id=child_job_id(run.run_id, kind, payload)):
        raise RuntimeError('SQS delivery is required for visual processing')


def dispatch(run):
    if run.status == 'ready':
        return
    # Fan out once: a chunk must never invoke the next chunk. Lambda rejects
    # SQS chains after about 16 invocations, even when each job is finite.
    # The existing event source mapping bounds concurrent executions.
    pending = checkpoints.pending_chunks(run)
    for index in pending:
        _send(run, JOB_BUILD_VIDEO_VISUAL_CHUNK, chunk_index=index)
    if not pending:
        _send(run, JOB_FINISH_VIDEO_VISUALS)


def start_visuals(video_id: int, file_key: str, duration: float):
    run = checkpoints.initialize(video_id, file_key, duration)
    if run:
        try:
            dispatch(run)
        except Exception as exc:
            checkpoints.record_failure(run, _redact_urls(str(exc)))
            raise


def build_video_visual_chunk(video_id: int, run_id: str, chunk_index: int, *, dispatch_next: bool = True):
    run = checkpoints.load_run(video_id, run_id)
    if not run or run.status == 'ready':
        return
    if not 0 <= chunk_index < run.chunk_count:
        raise ValueError('Invalid visual chunk index')
    try:
        if not checkpoints.chunk_complete(run, chunk_index):
            source = resolve_media_input(run.file_key)
            with build_visual_chunk(source, video_id, run.duration_ms / 1000, chunk_index) as (pack, sparse, count):
                if uses_internal_persistence():
                    from worker_python.tasks.cloud_visuals import publish_chunk
                    if not publish_chunk(run, chunk_index, pack, sparse, count):
                        return
                else:
                    # Publication and checkpoint share the video deletion lock.
                    # A retry after a failed PUT overwrites the same bounded objects.
                    with db_connection() as conn:
                        if not checkpoints.lock_current(conn, run):
                            return
                        upload_file(chunk_key(run.file_key, run.run_id, chunk_index), pack, 'application/octet-stream')
                        upload_bytes(chunk_key(run.file_key, run.run_id, chunk_index, 'json'), sparse, 'application/json')
                        conn.execute("""UPDATE video_visual_chunks SET frame_count = %s, last_error = '', updated_at = now()
                                        WHERE run_id = %s AND chunk_index = %s""", (count, run_id, chunk_index))
                        conn.execute("""UPDATE video_visual_runs SET status = 'processing', last_error = '' WHERE run_id = %s
                                        AND NOT EXISTS (SELECT 1 FROM video_visual_chunks WHERE run_id = %s AND last_error <> '')""",
                                     (run_id, run_id))
            logger.info('Visual checkpoint saved: video=%d chunk=%d/%d frames=%d', video_id, chunk_index + 1, run.chunk_count, count)
        if dispatch_next and not checkpoints.pending_chunks(run):
            _send(run, JOB_FINISH_VIDEO_VISUALS)
    except Exception as exc:
        checkpoints.record_failure(run, _redact_urls(str(exc)), chunk_index)
        raise


def finish_video_visuals(video_id: int, run_id: str):
    run = checkpoints.load_run(video_id, run_id)
    if not run or run.status == 'ready':
        return
    try:
        if uses_internal_persistence():
            from worker_python.tasks.cloud_visuals import finish_run
            finish_run(run)
            return
        with db_connection() as conn:
            rows = conn.execute('SELECT chunk_index, frame_count FROM video_visual_chunks WHERE run_id = %s ORDER BY chunk_index',
                                (run_id,)).fetchall()
        payload, manifest = publication_payloads(run, rows)
        with db_connection() as conn:
            if not checkpoints.lock_current(conn, run):
                return
            upload_bytes(frame_cache_key(run.file_key), payload, 'application/json')
            upload_bytes(manifest_key(run.file_key), manifest, 'application/json')
            conn.execute("UPDATE video_visual_runs SET status = 'ready', completed_at = now(), last_error = '' WHERE run_id = %s", (run_id,))
        logger.info('Visual preparation completed: video=%d chunks=%d frames=%d', video_id, run.chunk_count, sum(row['frame_count'] for row in rows))
    except Exception as exc:
        checkpoints.record_failure(run, _redact_urls(str(exc)))
        raise
