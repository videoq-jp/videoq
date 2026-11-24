"""Validated, leased job execution without queue, runtime or persistence imports."""
from dataclasses import dataclass
from typing import Callable
from worker_python.domain.jobs import (
    JOB_TRANSCRIBE_VIDEO, JOB_REINDEX_ALL_VIDEOS_EMBEDDINGS, JOB_DELETE_ACCOUNT_DATA,
    parse_job_message, job_group,
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
    message = parse_job_message(payload)
    job_type, job_id, body = message['type'], message['job_id'], message['payload']

    # Retired jobs may still be delivered from SQS or an old outbox.
    if job_type in {"build_plog", "evaluate_chat_log"}:
        deps.report("retired", job_type, job_id)
        return

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
