"""
AWS Lambda / local poller handler for SQS background jobs.

Native message shape (apps/api lib/jobs.ts):

{
  "type": "index_video_transcript",
  "job_id": "<uuid>",
  "payload": { "video_id": 123 }
}
"""

from __future__ import annotations

import base64
import json
import logging
import os

from worker_python.contracts import JOB_TRANSCRIBE_VIDEO, JOB_REINDEX_ALL_VIDEOS_EMBEDDINGS, validate_job_payload
from worker_python.job_execution import (
    claim_job_execution,
    complete_job_execution,
    fail_job_execution,
)
from worker_python.secrets_bootstrap import ensure_secrets_loaded
from worker_python.tasks.registry import get_task
from worker_python.job_routing import job_group

logger = logging.getLogger(__name__)


def handler(event: dict, context: object) -> dict:
    ensure_secrets_loaded()
    batch_item_failures = []

    for record in event.get("Records", []):
        message_id = record["messageId"]
        try:
            _execute_task(record["body"])
            logger.info("Task completed: messageId=%s", message_id)
        except Exception:
            logger.exception("Task failed: messageId=%s", message_id)
            batch_item_failures.append({"itemIdentifier": message_id})

    return {"batchItemFailures": batch_item_failures}


def _execute_task(raw_body: str) -> None:
    try:
        payload = json.loads(raw_body)
    except (json.JSONDecodeError, ValueError):
        payload = json.loads(base64.b64decode(raw_body).decode("utf-8"))

    if not isinstance(payload, dict):
        raise ValueError("Job message must be an object")
    job_type = payload.get("type")
    job_id = payload.get("job_id")
    body = payload.get("payload", {})
    if not isinstance(job_type, str) or not job_type or len(job_type) > 64:
        raise ValueError("type must be a non-empty string of at most 64 characters")
    if not isinstance(job_id, str) or not job_id or len(job_id) > 128:
        raise ValueError("job_id must be a non-empty string of at most 128 characters")
    if not isinstance(body, dict):
        raise ValueError("payload must be an object")

    # Retired jobs may still be delivered from SQS or an old outbox.
    if job_type in {"build_plog", "evaluate_chat_log"}:
        logger.info("Discarding retired job: type=%s id=%s", job_type, job_id)
        return

    validate_job_payload(job_type, body)
    group = os.environ.get("WORKER_JOB_GROUP", "").strip()
    if group and job_group(job_type) != group:
        raise ValueError(f"Job {job_type} does not belong to worker group {group}")

    logger.info(
        "Dispatching task: type=%s id=%s payload=%s",
        job_type,
        job_id,
        body,
    )

    lease_token = claim_job_execution(job_id, job_type, body)
    if lease_token is None:
        logger.info("Skipping completed duplicate job: type=%s id=%s", job_type, job_id)
        return

    try:
        task_fn = get_task(job_type)
        if job_type in {JOB_TRANSCRIBE_VIDEO, JOB_REINDEX_ALL_VIDEOS_EMBEDDINGS}:
            task_fn(**body, job_id=job_id)
        else:
            task_fn(**body)
        complete_job_execution(job_id, lease_token)
    except Exception as exc:
        try:
            fail_job_execution(job_id, lease_token, str(exc))
        except Exception:
            logger.exception("Failed to release execution lease: jobId=%s", job_id)
        raise
