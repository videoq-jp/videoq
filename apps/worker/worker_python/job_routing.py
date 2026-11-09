"""Queue selection shared by Lambda producers and the local poller."""

import os

from worker_python.contracts import (
    JOB_DELETE_ACCOUNT_DATA, JOB_INDEX_VIDEO_TRANSCRIPT,
    JOB_REINDEX_VIDEO_TRANSCRIPT, JOB_REINDEX_ALL_VIDEOS_EMBEDDINGS,
)


def job_group(job_type: str) -> str:
    if job_type == JOB_DELETE_ACCOUNT_DATA:
        return "account"
    if job_type in {
        JOB_INDEX_VIDEO_TRANSCRIPT, JOB_REINDEX_VIDEO_TRANSCRIPT,
        JOB_REINDEX_ALL_VIDEOS_EMBEDDINGS,
    }:
        return "search"
    return "media"


def queue_url_for_job(job_type: str) -> str:
    # A single queue remains supported for local/on-prem installations and rollout.
    group = job_group(job_type).upper()
    return (os.environ.get(f"SQS_{group}_QUEUE_URL", "").strip()
            or os.environ.get("SQS_QUEUE_URL", "").strip())
