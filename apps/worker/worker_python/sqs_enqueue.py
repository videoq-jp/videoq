"""Enqueue native job messages to SQS (same shape as apps/api lib/jobs.ts)."""

from __future__ import annotations

import json
import logging
import uuid
from contextlib import closing
from typing import Any

from worker_python.contracts import validate_job_payload
from worker_python.sqs_client import create_sqs_client
from worker_python.job_routing import queue_url_for_job

logger = logging.getLogger(__name__)


def build_job_message(
    job_type: str,
    payload: dict[str, Any] | None = None,
    *,
    job_id: str | None = None,
) -> dict[str, Any]:
    body = {} if payload is None else payload
    validate_job_payload(job_type, body)
    return {
        "type": job_type,
        "job_id": job_id or str(uuid.uuid4()),
        "payload": body,
    }


def child_job_id(
    parent_job_id: str,
    job_type: str,
    payload: dict[str, Any] | None = None,
) -> str:
    """Derive a stable UUID so a retried parent cannot create a new child job."""
    canonical = json.dumps(
        {
            "parent_job_id": parent_job_id,
            "type": job_type,
            "payload": payload or {},
        },
        sort_keys=True,
        separators=(",", ":"),
    )
    return str(uuid.uuid5(uuid.NAMESPACE_URL, f"videoq:{canonical}"))


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
    queue_url = queue_url_for_job(job_type)
    if not queue_url:
        logger.info(
            "SQS_QUEUE_URL unset; skip enqueue for %s payload=%s", job_type, payload
        )
        return None

    body = json.dumps(build_job_message(job_type, payload, job_id=job_id))
    with closing(create_sqs_client()) as client:
        resp = client.send_message(QueueUrl=queue_url, MessageBody=body)
    message_id = resp.get("MessageId")
    logger.info("Enqueued %s payload=%s messageId=%s", job_type, payload, message_id)
    return message_id
