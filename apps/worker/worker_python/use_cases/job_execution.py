"""Validated, leased job execution without queue, runtime or persistence imports."""
from dataclasses import dataclass
from typing import Callable
from worker_python.domain.jobs import (
    JOB_TRANSCRIBE_VIDEO, JOB_REINDEX_ALL_VIDEOS_EMBEDDINGS, JOB_DELETE_ACCOUNT_DATA,
    validate_job_payload, job_group,
)


@dataclass(frozen=True)
class JobExecutionDependencies:
    claim: Callable[[str, str, dict], str | None]
    task: Callable[[str], Callable[..., None]]
    complete: Callable[[str, str], None]
    fail: Callable[[str, str, str], None]
    internal_persistence: Callable[[], bool]
    worker_group: Callable[[], str]
    report: Callable[[str, str, str], None]


def execute_job(payload: object, deps: JobExecutionDependencies) -> None:
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
        deps.report("retired", job_type, job_id)
        return

    validate_job_payload(job_type, body)
    group = deps.worker_group()
    if group and job_group(job_type) != group:
        raise ValueError(f"Job {job_type} does not belong to worker group {group}")

    deps.report("dispatch", job_type, job_id)

    lease_token = deps.claim(job_id, job_type, body)
    if lease_token is None:
        deps.report("duplicate", job_type, job_id)
        return

    try:
        task_fn = deps.task(job_type)
        if job_type in {JOB_TRANSCRIBE_VIDEO, JOB_REINDEX_ALL_VIDEOS_EMBEDDINGS}:
            task_fn(**body, job_id=job_id)
        elif job_type == JOB_DELETE_ACCOUNT_DATA and deps.internal_persistence():
            task_fn(**body, job_id=job_id, lease_token=lease_token)
        else:
            task_fn(**body)
        deps.complete(job_id, lease_token)
    except Exception:
        try:
            deps.fail(job_id, lease_token, "WORKER_EXECUTION_FAILED")
        except Exception:
            deps.report("release_failed", job_type, job_id)
        raise
