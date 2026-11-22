---
title: Job delivery and recovery
description: Follow upload completion, queue delivery, and background processing retries.
---

# Job delivery and recovery

Processing a video requires both saving it in the database and delivering work to the worker. Delivery intentions are also recorded in the DB so an API or network interruption does not lose the job.

## From upload to job

```mermaid
flowchart TD
    Request[Request upload] --> Check{Check permissions, size, and usage}
    Check -->|Allowed| Reserve[Reserve storage and create video]
    Check -->|Rejected| Error[Return error]
    Reserve --> Upload[Upload video to signed URL]
    Upload --> Confirm[Notify API of completion]
    Confirm --> Commit[Save video state and delivery intent in DB]
    Commit --> Send[Send media job to SQS]
    Send --> Worker[Python media worker]
    Worker --> Intent[Persist indexing intent]
    Intent --> Edition{Deployment}
    Edition -->|Cloud| Queue[Cloudflare search Queue]
    Queue --> Workflow[SearchIndexWorkflow]
    Edition -->|On-prem| NodeQueue[Dedicated search SQS queue]
    NodeQueue --> Node[Node background worker]
```

A signed URL is a time-limited URL for uploading the target file. The file goes to storage while the API manages permissions and state.

## If delivery fails

`external_tasks` is an **outbox** that stores delivery intentions. Writing it in the same transaction as business data makes it possible to recover when the DB update succeeds but dispatch does not.

```mermaid
flowchart LR
    Saved[Save delivery intent in DB] --> Send[Send to selected queue]
    Send -->|Success| Done[Record delivery completion]
    Send -->|Failure or interruption| Pending[Undelivered record remains]
    Pending --> Alarm[TaskScheduler alarm or on-prem recovery job]
    Alarm --> Send
```

Delivery normally happens during API processing. Cloud `TASK_SCHEDULER` alarms and on-prem maintenance jobs recover failed or interrupted dispatch. Successful delivery is distinct from successful worker execution. Account jobs use the same durable outbox and select the account queue.

SQS dispatch makes one HTTP request with a 10-second deadline. Native cloud background delivery uses Cloudflare Queue bindings. Transport failures return to the outbox, which persists the next attempt time and retries with the same `job_id`. Search queue acknowledgement means a durable workflow instance exists; the workflow still needs to finish indexing and vector readiness checks.

## If the worker stops midway

SQS and Cloudflare Queues may redeliver the same job. Python media and TypeScript background processors keep execution records keyed by `job_id` in `job_executions`.

- Completed jobs are not processed again.
- Running jobs acquire a time-limited execution lease.
- If processing stops, the job can run again after the lease expires.
- Follow-up job IDs are derived from the parent job so retries do not create distinct jobs.

This mechanism does not automatically make arbitrary external API operations execute exactly once. Each processing step must also define how it behaves on retry.

## Where to look

| Area | Implementation |
|---|---|
| API delivery intentions and dispatch | [external-tasks.ts](https://github.com/videoq-jp/videoq/blob/main/apps/api/src/lib/external-tasks.ts) |
| Scheduling recovery | [task-scheduler.ts](https://github.com/videoq-jp/videoq/blob/main/apps/api/src/durable-objects/task-scheduler.ts) |
| Media leases and duplicate protection | [job_execution.py](https://github.com/videoq-jp/videoq/blob/main/apps/worker/worker_python/job_execution.py) |
| Media indexing handoff | [sqs_enqueue.py](https://github.com/videoq-jp/videoq/blob/main/apps/worker/worker_python/sqs_enqueue.py) |
| TypeScript job leases and execution | [background-job.ts](https://github.com/videoq-jp/videoq/blob/main/apps/api/src/application/background-job.ts) |
| Cloud search checkpoints | [search-index.ts](https://github.com/videoq-jp/videoq/blob/main/apps/api/src/workflows/search-index.ts) |

**Related:** [State transitions](../design/state-diagram.md), [Change asynchronous processing](../guides/worker.md), [Troubleshooting](../guides/troubleshooting.md).
