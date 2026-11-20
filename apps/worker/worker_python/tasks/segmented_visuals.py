"""Bounded visual decoding with durable checkpoints and atomic readiness."""

import logging

from worker_python import visual_checkpoints as checkpoints
from worker_python.contracts import JOB_BUILD_VIDEO_VISUAL_CHUNK, JOB_FINISH_VIDEO_VISUALS
from worker_python.db import db_connection
from worker_python.domain.visual_checkpoints import visual_chunk_publication, VisualRunPublication
from worker_python.video_policy_sql import VIDEO_POLICY_SQL
from worker_python.internal_api import uses_internal_persistence
from worker_python.pipeline.visual_publication import publication_payloads
from worker_python.pipeline.media_process import _redact_urls
from worker_python.pipeline.storage import resolve_media_input, upload_file, upload_bytes
from worker_python.pipeline.visual_chunks import build_visual_chunk, chunk_key, manifest_key
from worker_python.pipeline.visual_frames import frame_cache_key
from worker_python.sqs_enqueue import child_job_id, enqueue_job

from worker_python.use_cases.segmented_visuals import (
    SegmentedVisualDependencies, dispatch_visuals, start_visuals as execute_start,
    build_visual, finish_visuals,
)

logger = logging.getLogger(__name__)


def _send(run, kind, **extra):
    payload = {'video_id': run.video_id, 'run_id': run.run_id, **extra}
    if not enqueue_job(kind, payload, job_id=child_job_id(run.run_id, kind, payload)):
        raise RuntimeError('SQS delivery is required for visual processing')


def _build_and_publish(run, chunk_index):
    source = resolve_media_input(run.file_key)
    with build_visual_chunk(source, run.video_id, run.duration_ms / 1000, chunk_index) as (pack, sparse, count):
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
                plan = visual_chunk_publication(
                    "EXISTS (SELECT 1 FROM video_visual_chunks WHERE run_id = %s AND last_error <> '')",
                    VIDEO_POLICY_SQL.negate,
                )
                conn.execute("""UPDATE video_visual_chunks SET frame_count = %s, last_error = %s, updated_at = now()
                                WHERE run_id = %s AND chunk_index = %s""", (count, plan.chunk_error, run.run_id, chunk_index))
                conn.execute(f"""UPDATE video_visual_runs SET status = %s, last_error = %s WHERE run_id = %s
                                 AND {plan.recover_run}""", (plan.run_status, plan.run_error, run.run_id, run.run_id))
    logger.info('Visual checkpoint saved: video=%d chunk=%d/%d frames=%d', run.video_id, chunk_index + 1, run.chunk_count, count)
    return count


def _finish_run(run):
    if uses_internal_persistence():
        from worker_python.tasks.cloud_visuals import finish_run
        finish_run(run)
        return
    with db_connection() as conn:
        rows = conn.execute('SELECT chunk_index, frame_count FROM video_visual_chunks WHERE run_id = %s ORDER BY chunk_index',
                            (run.run_id,)).fetchall()
    payload, manifest = publication_payloads(run, rows)
    with db_connection() as conn:
        if not checkpoints.lock_current(conn, run):
            return
        upload_bytes(frame_cache_key(run.file_key), payload, 'application/json')
        upload_bytes(manifest_key(run.file_key), manifest, 'application/json')
        completed = VisualRunPublication()
        conn.execute("UPDATE video_visual_runs SET status = %s, completed_at = now(), last_error = %s WHERE run_id = %s",
                     (completed.status, completed.error, run.run_id))
    logger.info('Visual preparation completed: video=%d chunks=%d frames=%d', run.video_id, run.chunk_count, sum(row['frame_count'] for row in rows))


def _dependencies():
    return SegmentedVisualDependencies(
        initialize=checkpoints.initialize, load=checkpoints.load_run,
        pending=checkpoints.pending_chunks, complete=checkpoints.chunk_complete,
        build_and_publish=_build_and_publish, finish=_finish_run,
        send_chunk=lambda run, index: _send(run, JOB_BUILD_VIDEO_VISUAL_CHUNK, chunk_index=index),
        send_finish=lambda run: _send(run, JOB_FINISH_VIDEO_VISUALS),
        record_failure=lambda run, error, index: checkpoints.record_failure(run, _redact_urls(str(error)), index),
    )


def dispatch(run):
    dispatch_visuals(run, _dependencies())


def start_visuals(video_id: int, file_key: str, duration: float):
    execute_start(video_id, file_key, duration, _dependencies())


def build_video_visual_chunk(video_id: int, run_id: str, chunk_index: int, *, dispatch_next: bool = True):
    build_visual(video_id, run_id, chunk_index, _dependencies(), dispatch_next=dispatch_next)


def finish_video_visuals(video_id: int, run_id: str):
    finish_visuals(video_id, run_id, _dependencies())
