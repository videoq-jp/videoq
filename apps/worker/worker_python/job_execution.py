"""DB-backed idempotency guard for at-least-once SQS/Lambda delivery."""

from __future__ import annotations

import hashlib
import json
import uuid
from typing import Any

from worker_python.db import db_connection
from worker_python.internal_api import call_internal_api, uses_internal_persistence

# Lambda is capped at 15 minutes; SQS visibility is at least six times as long.
JOB_LEASE_SECONDS = 15 * 60


class JobIdentityConflictError(RuntimeError):
    """The same job_id was reused with different work."""


class JobExecutionBusyError(RuntimeError):
    """The prior delivery still owns a valid lease; let SQS retry this copy."""


def _payload_sha256(job_type: str, payload: dict[str, Any]) -> str:
    canonical = json.dumps(
        {"type": job_type, "payload": payload},
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    )
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def claim_job_execution(
    job_id: str,
    job_type: str,
    payload: dict[str, Any],
) -> str | None:
    """Claim new/failed/expired work; completed duplicates return None, active ones retry."""
    payload_hash = _payload_sha256(job_type, payload)
    if uses_internal_persistence():
        result = call_internal_api("claim", {
            "jobId": job_id, "jobType": job_type, "payloadSha256": payload_hash,
        })
        status = result.get("status")
        if status == "completed":
            return None
        if status == "busy":
            raise JobExecutionBusyError(f"Job execution is still running: {job_id}")
        if status == "conflict":
            raise JobIdentityConflictError(f"Job identity conflict: {job_id}")
        token = result.get("leaseToken")
        if status != "claimed" or not isinstance(token, str) or not token:
            raise RuntimeError("Invalid job claim response")
        return token
    lease_token = str(uuid.uuid4())

    with db_connection() as conn:
        inserted = conn.execute(
            """
            INSERT INTO job_executions
                (job_id, job_type, payload_sha256, status, attempts,
                 lease_token, lease_until, created_at, updated_at)
            VALUES (%s, %s, %s, 'running', 1, %s,
                    NOW() + (%s * INTERVAL '1 second'), NOW(), NOW())
            ON CONFLICT (job_id) DO NOTHING
            RETURNING job_id
            """,
            (job_id, job_type, payload_hash, lease_token, JOB_LEASE_SECONDS),
        ).fetchone()
        if inserted is not None:
            return lease_token

        existing = conn.execute(
            """
            SELECT job_type, payload_sha256, status,
                   lease_until IS NOT NULL AND lease_until > NOW() AS lease_active
              FROM job_executions
             WHERE job_id = %s
             FOR UPDATE
            """,
            (job_id,),
        ).fetchone()
        if existing is None:
            raise RuntimeError(f"Job execution disappeared: {job_id}")
        if existing["job_type"] != job_type or existing["payload_sha256"] != payload_hash:
            raise JobIdentityConflictError(
                f"job_id {job_id!r} was reused with a different type or payload"
            )
        if existing["status"] == "completed":
            return None
        if existing["status"] == "running" and existing["lease_active"]:
            raise JobExecutionBusyError(f"Job execution is still running: {job_id}")

        claimed = conn.execute(
            """
            UPDATE job_executions
               SET status = 'running',
                   attempts = attempts + 1,
                   lease_token = %s,
                   lease_until = NOW() + (%s * INTERVAL '1 second'),
                   last_error = '',
                   updated_at = NOW()
             WHERE job_id = %s
            RETURNING job_id
            """,
            (lease_token, JOB_LEASE_SECONDS, job_id),
        ).fetchone()
        if claimed is None:
            raise RuntimeError(f"Failed to claim job execution: {job_id}")
        return lease_token


def complete_job_execution(job_id: str, lease_token: str) -> None:
    if uses_internal_persistence():
        result = call_internal_api("complete", {"jobId": job_id, "leaseToken": lease_token})
        if result.get("updated") is not True:
            raise RuntimeError(f"Job execution lease was lost: {job_id}")
        return
    with db_connection() as conn:
        completed = conn.execute(
            """
            UPDATE job_executions
               SET status = 'completed',
                   lease_token = NULL,
                   lease_until = NULL,
                   completed_at = NOW(),
                   last_error = '',
                   updated_at = NOW()
             WHERE job_id = %s
               AND status = 'running'
               AND lease_token = %s
            RETURNING job_id
            """,
            (job_id, lease_token),
        ).fetchone()
        if completed is None:
            raise RuntimeError(f"Job execution lease was lost: {job_id}")


def fail_job_execution(job_id: str, lease_token: str, error: str) -> None:
    if uses_internal_persistence():
        call_internal_api("fail", {"jobId": job_id, "leaseToken": lease_token,
                                   "errorCode": "WORKER_EXECUTION_FAILED"})
        return
    with db_connection() as conn:
        conn.execute(
            """
            UPDATE job_executions
               SET status = 'failed',
                   lease_token = NULL,
                   lease_until = NULL,
                   last_error = %s,
                   updated_at = NOW()
             WHERE job_id = %s
               AND status = 'running'
               AND lease_token = %s
            """,
            (error[:2000], job_id, lease_token),
        )
