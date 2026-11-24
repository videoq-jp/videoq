#!/usr/bin/env python3
"""
Local and on-prem SQS poller — Lambda substitute for apps/worker.

Long-polls SQS_QUEUE_URL, feeds each message to lambda_handler.handler,
and deletes successful messages (failed ones become visible again / DLQ).

  docker compose up -d postgres garage garage-init elasticmq
  export DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:55432/postgres
  export SQS_QUEUE_URL=http://127.0.0.1:9324/000000000000/videoq-jobs
  export AWS_REGION=us-east-1
  # ElasticMQ uses dummy AWS keys; Garage uses separate R2_* credentials.
  export AWS_ACCESS_KEY_ID=local AWS_SECRET_ACCESS_KEY=local
  export USE_S3_STORAGE=true
  export R2_ACCESS_KEY_ID=GK00000000000000000000000000000000
  export R2_SECRET_ACCESS_KEY=0000000000000000000000000000000000000000000000000000000000000000
  export R2_BUCKET_NAME=videoq-media
  export R2_S3_ENDPOINT=http://127.0.0.1:9000 R2_S3_REGION=garage
  python scripts/run_worker.py
"""

from __future__ import annotations

import logging
import os
import signal
import sys
import threading
import time
from contextlib import closing
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

# Direct script execution needs the repository path above before these imports.
from worker_python.lambda_handler import handler  # noqa: E402
from worker_python.sqs_client import create_sqs_client  # noqa: E402

logging.basicConfig(
    level=os.environ.get("LOG_LEVEL", "INFO"),
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
logger = logging.getLogger("run_worker")


class JobDeadlineExceeded(BaseException):
    """Match Lambda's hard deadline without letting a handler swallow it."""


def _deadline(_signum, _frame):
    raise JobDeadlineExceeded("Job exceeded the on-prem execution deadline")


def _poll(stop: threading.Event) -> int:
    queue_url = os.environ.get("SQS_QUEUE_URL", "").strip()
    if not queue_url:
        logger.error("SQS_QUEUE_URL is required")
        return 2

    wait = int(os.environ.get("SQS_WAIT_TIME_SECONDS", "20"))
    visibility = int(os.environ.get("SQS_VISIBILITY_TIMEOUT", "900"))
    max_messages = int(os.environ.get("SQS_MAX_MESSAGES", "1"))
    deadline = int(os.environ.get("SQS_JOB_TIMEOUT_SECONDS", "840"))
    if not 1 <= deadline < min(visibility, 900):
        raise ValueError("SQS_JOB_TIMEOUT_SECONDS must be positive and below visibility and the 900s DB lease")

    with closing(create_sqs_client()) as client:
        logger.info(
            "Polling %s (wait=%ss visibility=%ss). Ctrl+C to stop.",
            queue_url,
            wait,
            visibility,
        )

        while not stop.is_set():
            try:
                resp = client.receive_message(
                    QueueUrl=queue_url,
                    MaxNumberOfMessages=max(1, min(max_messages, 10)),
                    WaitTimeSeconds=wait,
                    VisibilityTimeout=visibility,
                    MessageSystemAttributeNames=['ApproximateReceiveCount'],
                )
            except KeyboardInterrupt:
                logger.info("Stopped")
                return 0
            except Exception:
                logger.exception("ReceiveMessage failed; retry in 3s")
                time.sleep(3)
                continue

            messages = resp.get("Messages") or []
            if stop.is_set():
                break
            if not messages:
                continue

            event = {
                "Records": [
                    {"messageId": m["MessageId"], "body": m["Body"],
                     **({'attributes': m['Attributes']} if 'Attributes' in m else {})} for m in messages
                ]
            }

            try:
                signal.setitimer(signal.ITIMER_REAL, deadline)
                result = handler(event, None)
            except JobDeadlineExceeded:
                logger.error("Job deadline exceeded; leaving messages for retry after lease expiry")
                continue
            except Exception:
                logger.exception(
                    "handler crashed; messages will reappear after visibility timeout"
                )
                continue
            finally:
                signal.setitimer(signal.ITIMER_REAL, 0)

            failed = {
                item["itemIdentifier"]
                for item in (result or {}).get("batchItemFailures", [])
            }
            for message in messages:
                mid = message["MessageId"]
                if mid in failed:
                    logger.warning("Leaving message %s for retry/DLQ", mid)
                    continue
                try:
                    client.delete_message(
                        QueueUrl=queue_url,
                        ReceiptHandle=message["ReceiptHandle"],
                    )
                    logger.info("Deleted message %s", mid)
                except Exception:
                    logger.exception("DeleteMessage failed for %s", mid)
    return 0


def main() -> int:
    stop = threading.Event()
    # Stop receiving new work, then finish and acknowledge the active job.
    previous_term = signal.signal(signal.SIGTERM, lambda *_: stop.set())
    previous_alarm = signal.signal(signal.SIGALRM, _deadline)
    try:
        return _poll(stop)
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.signal(signal.SIGTERM, previous_term)
        signal.signal(signal.SIGALRM, previous_alarm)


if __name__ == "__main__":
    raise SystemExit(main())
