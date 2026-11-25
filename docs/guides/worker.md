---
title: Change asynchronous video processing
description: Media workers, TypeScript background jobs, retries, and local verification.
---

# Change asynchronous video processing

Python handles media processing: transcription, visual preparation, chunks, and finalizers. Search indexing and account deletion use shared TypeScript processors in `apps/api`. API operations save a durable delivery intent before dispatching a job.

## Processing entry points

| What you want to change | Main location |
|---|---|
| Media job types and dispatch | `apps/worker/worker_python/contracts.py`, `tasks/registry.py` |
| Media lifecycle and provider adapters | `apps/worker/worker_python/use_cases/`, `tasks/`, `pipeline/` |
| Media execution leases and Lambda entry point | `apps/worker/worker_python/job_execution.py`, `lambda_handler.py` |
| Search and account job validation | `apps/api/src/application/background-job.ts` |
| Shared TypeScript background execution | `apps/api/src/integrations/background-jobs/execute.ts` |
| Cloudflare transport and consumers | `apps/api/src/integrations/background-jobs/delivery.ts`, `queue.ts` |
| Durable cloud search indexing | `apps/api/src/workflows/search-index.ts` |
| On-prem background worker | `apps/api/src/runtime/background-worker.ts` |
| PostgreSQL vector replacement | `apps/api/src/persistence/postgres/transcript-index-writer.ts` |

The common message format is defined in [job-message.ts](https://github.com/videoq-jp/videoq/blob/main/apps/api/src/lib/job-message.ts).

## Hosted execution groups

The media Lambda consumes its existing SQS queue and DLQ. Media persists search indexing intent through the signed internal API; Python does not compute search embeddings or write search vectors inline.

Cloudflare Queues deliver account jobs to the API Worker's queue handler and search jobs to `SearchIndexWorkflow`. The workflow uses Workers AI, D1, R2 checkpoints, and Vectorize. The queue consumer acknowledges search delivery after a durable workflow instance exists. Queue delivery and workflow completion are separate events.

Keep legacy search/account Lambda consumers and their queues until the production transport cutover, maximum old execution window, and visible/in-flight/delayed message and DLQ drain checks have passed. See the [worker README](https://github.com/videoq-jp/videoq/blob/main/apps/worker/README.md) and [deployment instructions](https://github.com/videoq-jp/videoq/blob/main/infra/DEPLOY.md) for rollout gates.

## On-prem execution groups

The Node `background-worker` service consumes dedicated search and account SQS-compatible queues. The Python `worker` service consumes media jobs. Compose includes both; Helm requires the Node worker and separate queue URLs.

Search uses PostgreSQL with `@videoq-jp/langchainjs-postgres`. Embeddings use the configured OpenAI-compatible endpoint through `@langchain/openai`. Local inference services can provide that endpoint without public egress. Cloudflare storage bindings are not required on-prem.

## Message format

```json
{
  "type": "transcribe_video",
  "job_id": "a-uuid-identifying-the-job",
  "payload": {"video_id": 123}
}
```

Normally, API operations create jobs; you do not need to submit queue messages manually.

For an uploaded file, `transcribe_video` creates an interval plan, `transcribe_video_chunk` saves each interval, and `finish_video_transcription` joins them. Indexing is then handed to TypeScript, while visual-cache jobs remain in Python. YouTube imports have no interval jobs. See [video states](../design/state-diagram.md).

## Design for retries

Queues can deliver a message more than once. Both runtimes use `job_executions`, stable job IDs, and time-limited leases. Completed jobs are skipped. Every mutation must still preserve its own revision or ownership fence: a lease does not make arbitrary provider operations execute exactly once.

Cloud search checkpoints durable steps and stores large subtitles and vector artifacts in R2. Vector publication and readiness are separate; completing dispatch does not mean the video is searchable yet. Account deletion rechecks its live job lease, permanent user ban, and matching outbox intent during cleanup.

Full reindexing dispatches at most 25 video IDs per job and persists a continuation for the next page. Each video completes and retries independently. Dispatcher success confirms delivery, not completion of all child jobs.

## Database transaction boundaries

For Python media operations on PostgreSQL, use `with db_connection() as conn`. Normal exit commits, an exception rolls back, and the connection is closed even if committing fails. Keep provider calls outside the transaction.

TypeScript PostgreSQL indexing replaces a video's vectors atomically after validating the transcript snapshot and storage dimensions. Its `PGVectorStore` engine stays on the transaction's pinned client. D1 indexing stages an immutable scene revision, publishes it conditionally, and waits for Vectorize readiness. Preserve these boundaries when changing either adapter.

## Trace processing locally

Restart the affected service after changing its runtime code. Rebuild the image if dependencies changed.

```bash
docker compose restart worker background-worker
docker compose logs --tail=100 worker background-worker
docker compose logs -f worker background-worker
```

Upload a short video through the UI and follow its video ID in the logs. `Ctrl+C` stops log streaming but leaves the services running. Check the configured inference endpoint when investigating transcription or embedding failures.

See [tests and verification commands](testing.md) for API, worker, and on-prem verification. Connection and model settings are documented in the [worker README](https://github.com/videoq-jp/videoq/blob/main/apps/worker/README.md).

**Related:** [Job delivery and recovery](../architecture/flowchart.md).
