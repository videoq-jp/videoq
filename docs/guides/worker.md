---
title: Change asynchronous video processing
description: Job entry points, pipeline implementation, retries, and local verification.
---

# Change asynchronous video processing

Transcription and indexing take time, so the Python worker runs them without blocking API responses. The API submits a job requesting that a video be processed, and the worker consumes it from the queue.

## Processing entry points

| What you want to change | Main location |
|---|---|
| Job types and payloads | `apps/worker/worker_python/contracts.py` |
| Mapping job names to functions | `worker_python/tasks/registry.py` |
| State updates and dispatching the next job | `worker_python/tasks/` |
| Transcription and search implementation | `worker_python/pipeline/` |
| Duplicate execution control | `worker_python/job_execution.py` |
| AWS Lambda entry point | `worker_python/lambda_handler.py` |

All of these files are under `apps/worker/`. Also check the API's message format in [job-message.ts](https://github.com/videoq-jp/videoq/blob/main/apps/api/src/lib/job-message.ts).

## Message format

```json
{
  "type": "transcribe_video",
  "job_id": "a-uuid-identifying-the-job",
  "payload": {"video_id": 123}
}
```

This illustrates the format. Normally, API operations create jobs; you do not need to submit queue messages manually.

For an uploaded file, `transcribe_video` creates an interval plan, `transcribe_video_chunk` saves each interval, and `finish_video_transcription` joins them, then starts `index_video_transcript` and the visual-cache jobs (`build_video_visual_chunk` → `finish_video_visuals`). YouTube imports have no interval jobs. See [video states](../design/state-diagram.md).

Each task checks its entry status, and conditional database updates recheck the
stored status before changing it. Transcription starts for pending/error videos,
resumes processing videos, hands indexing videos to the index task, and skips
completed duplicates. Uploading or unknown statuses are rejected before writes
or provider calls.

## Design for retries

SQS may deliver the same message more than once. The worker uses execution records keyed by `job_id` and time-limited leases to avoid repeating completed work. Follow-up job IDs are also derived from the parent job.

When adding processing, check whether retrying after a partial failure could duplicate data or downstream jobs. This property is called **idempotency**. Swallowing an exception can prevent retries and leave a job in an intermediate state.

Tasks return no result payload. The dispatcher records successful execution after
the task returns; exceptions trigger the existing retry handling. Full reindexing
reports counts in its logs and raises if any video fails.

## Database transaction boundaries

Use `with db_connection() as conn` for a database unit of work. Normal exit commits,
an exception rolls back, and the connection is closed even if committing fails.
Keep AI provider calls outside this block so they do not hold a database connection
or transaction open. Helpers receiving a connection execute SQL within the
caller's transaction; the caller owns when it commits.

Explicit intermediate commits remain necessary when a connection serves several
transactions. Account deletion commits each completed step and uses a separate
transaction per video, allowing retries after a storage failure without losing
the remaining cleanup work.

## Trace processing locally

Restart a running worker after editing Python code so it reloads the changes. Rebuild the image if dependencies changed.

```bash
docker compose restart worker
```

```bash
docker compose logs --tail=100 worker
docker compose logs -f worker
```

Upload a short video through the UI and follow its video ID in the logs. `Ctrl+C` stops log streaming but leaves the worker running. Transcription and embeddings call the configured external APIs.

See [tests and verification commands](testing.md) for the Python test environment. Connection and model settings are documented in the [worker README](https://github.com/videoq-jp/videoq/blob/main/apps/worker/README.md).

**Related:** [Job delivery and recovery](../architecture/flowchart.md).
