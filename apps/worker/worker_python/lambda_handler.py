"""
AWS Lambda / local poller handler for SQS background jobs.

Native message shape (apps/api lib/jobs.ts):

{
  "type": "transcribe_video",
  "job_id": "<uuid>",
  "payload": { "video_id": 123 }
}
"""

from __future__ import annotations

from worker_python.runtime_security import verify_hashlib_runtime

verify_hashlib_runtime()

import base64
import json
import logging
import os
import time

from worker_python.job_execution import (
    claim_job_execution,
    complete_job_execution,
    fail_job_execution,
)
from worker_python.internal_api import uses_internal_persistence, validate_internal_persistence
from worker_python.secrets_bootstrap import ensure_secrets_loaded
from worker_python.tasks.registry import get_task
from worker_python.job_diagnostics import job_failure, receive_attempts
from worker_python.use_cases.job_execution import execute_job, JobExecutionDependencies

logger = logging.getLogger(__name__)


def handler(event: dict, context: object) -> dict:
    verify_hashlib_runtime()
    ensure_secrets_loaded()
    validate_internal_persistence()
    batch_item_failures = []

    for record in event.get("Records", []):
        message_id = record["messageId"]
        started = time.monotonic()
        observation = {'stage': 'decode'}
        try:
            _execute_task(record["body"], observation)
            logger.info("Task completed: messageId=%s", message_id)
        except Exception as error:
            # Provider/DB exception messages can contain signed URLs, tokens or
            # private scene data. SQS needs the failed identifier, not a trace.
            logger.error(json.dumps({
                'event': 'background_job_retry', 'message_id': message_id, **observation,
                'attempts': receive_attempts(record.get('attributes', {}).get('ApproximateReceiveCount')),
                'duration_ms': max(0, round((time.monotonic() - started) * 1000)),
                **job_failure(error, observation['stage']),
            }))
            batch_item_failures.append({"itemIdentifier": message_id})

    return {"batchItemFailures": batch_item_failures}


def _execute_task(raw_body: str, observation: dict | None = None) -> None:
    observation = {} if observation is None else observation
    try:
        payload = json.loads(raw_body)
    except (json.JSONDecodeError, ValueError):
        payload = json.loads(base64.b64decode(raw_body).decode("utf-8"))

    observation['stage'] = 'validate'

    def report(event, kind, job_id):
        # Dispatch is reported only after the entire envelope has been validated.
        observation.update(job_type=kind, job_id=job_id)
        _report_job_event(event, kind, job_id)

    def claim(*args):
        observation['stage'] = 'claim'
        return claim_job_execution(*args)

    def task(kind):
        observation['stage'] = 'execute'
        return get_task(kind)

    def complete(*args):
        observation['stage'] = 'complete'
        return complete_job_execution(*args)

    execute_job(payload, JobExecutionDependencies(
        claim=claim, task=task, complete=complete,
        fail=fail_job_execution, internal_persistence=uses_internal_persistence,
        worker_group=lambda: os.environ.get("WORKER_JOB_GROUP", "").strip(),
        report=report,
    ))


def _report_job_event(event: str, job_type: str, job_id: str) -> None:
    if event == "release_failed":
        logger.error("Failed to release execution lease: jobId=%s", job_id)
        return
    messages = {
        "retired": "Discarding retired job: type=%s id=%s",
        "dispatch": "Dispatching task: type=%s id=%s",
        "duplicate": "Skipping completed duplicate job: type=%s id=%s",
    }
    logger.info(messages[event], job_type, job_id)
