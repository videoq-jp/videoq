#!/usr/bin/env python3
"""
Enqueue local pending/indexing videos for the media and TypeScript workers.

Usage (from apps/worker/):
  export DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:55432/postgres
  export SQS_QUEUE_URL=http://127.0.0.1:9324/000000000000/videoq-jobs
  export SQS_SEARCH_QUEUE_URL=http://127.0.0.1:9324/000000000000/videoq-search
  export AWS_ACCESS_KEY_ID=local AWS_SECRET_ACCESS_KEY=local AWS_REGION=us-east-1
  python scripts/process_pending.py
  python scripts/process_pending.py --video-id 83
"""

from __future__ import annotations

import argparse
import logging
import os
import sys

# Allow `python scripts/process_pending.py` without install.
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from worker_python.db import db_connection
from worker_python.sqs_enqueue import enqueue_job
from worker_python.contracts import JOB_INDEX_VIDEO_TRANSCRIPT, JOB_TRANSCRIBE_VIDEO

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
logger = logging.getLogger("process_pending")


def list_targets(video_id: int | None) -> list[tuple[int, str]]:
    with db_connection() as conn:
        if video_id is not None:
            row = conn.execute(
                "SELECT id, status FROM videos WHERE id = %s",
                (video_id,),
            ).fetchone()
            return [(int(row["id"]), row["status"])] if row else []
        rows = conn.execute(
            """
            SELECT id, status
              FROM videos
             WHERE status IN ('pending', 'error', 'indexing')
             ORDER BY id
            """
        ).fetchall()
        return [(int(r["id"]), r["status"]) for r in rows]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--video-id", type=int, default=None)
    args = parser.parse_args()

    if not os.environ.get("DATABASE_URL"):
        logger.error("DATABASE_URL is required")
        return 2

    targets = list_targets(args.video_id)
    if not targets:
        logger.info("No pending/error/indexing videos found")
        return 0

    for vid, status in targets:
        logger.info("Processing video %d (status=%s)", vid, status)
        try:
            job_type = JOB_INDEX_VIDEO_TRANSCRIPT if status == "indexing" else JOB_TRANSCRIBE_VIDEO
            if not enqueue_job(job_type, {"video_id": vid}):
                raise RuntimeError("Queue is unavailable; no inline processing is supported")
        except Exception:
            logger.exception("Failed video %d", vid)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
