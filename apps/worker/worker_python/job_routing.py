"""Environment adapter for queue selection; grouping is a pure job policy."""
import os
from worker_python.domain.jobs import job_group


def queue_url_for_job(job_type: str) -> str:
    # A single queue remains supported for local/on-prem installations and rollout.
    group = job_group(job_type).upper()
    return (os.environ.get(f"SQS_{group}_QUEUE_URL", "").strip()
            or os.environ.get("SQS_QUEUE_URL", "").strip())
