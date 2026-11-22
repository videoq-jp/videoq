"""Enqueue native job messages to SQS (same shape as apps/api lib/jobs.ts)."""

from __future__ import annotations

import json
import logging
import os
import uuid
from contextlib import closing
from typing import Any

from worker_python.domain.jobs import build_job_message as prepare_job_message, child_job_id
from worker_python.sqs_client import create_sqs_client
from worker_python.job_routing import queue_url_for_job

logger = logging.getLogger(__name__)


def build_job_message(
    job_type: str,
    payload: dict[str, Any] | None = None,
    *,
    job_id: str | None = None,
) -> dict[str, Any]:
    return prepare_job_message(job_type, payload, job_id=job_id, new_id=lambda: str(uuid.uuid4()))


def enqueue_job(
    job_type: str,
    payload: dict[str, Any] | None = None,
    *,
    job_id: str | None = None,
) -> str | None:
    """
    Send a native job message to SQS when configured.

    Returns MessageId, or None when SQS is not configured (caller should fall back).
    """
    if os.environ.get("SEARCH_JOB_BACKEND") == "cloudflare":
        from worker_python.domain.jobs import job_group
        if job_group(job_type) == "search":
            from worker_python.internal_api import call_internal_api
            message = build_job_message(job_type, payload, job_id=job_id)
            result = call_internal_api("enqueue", message)
            if result.get("messageId") != message["job_id"]:
                raise RuntimeError("Invalid internal enqueue response")
            return message["job_id"]

    queue_url = queue_url_for_job(job_type)
    if not queue_url:
        logger.info(
            "SQS_QUEUE_URL unset; skip enqueue for %s", job_type
        )
        return None

    body = json.dumps(build_job_message(job_type, payload, job_id=job_id))
    with closing(create_sqs_client()) as client:
        resp = client.send_message(QueueUrl=queue_url, MessageBody=body)
    message_id = resp.get("MessageId")
    logger.info("Enqueued %s messageId=%s", job_type, message_id)
    return message_id
