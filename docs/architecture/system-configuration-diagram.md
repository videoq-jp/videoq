---
title: System overview
description: The roles of the frontend, API, and video processing, and how local services map to production.
---

# System overview

VideoQ separates the API that responds to user actions from time-consuming video processing. Start with the three application components in this diagram to understand each technology's role.

```mermaid
flowchart LR
    Browser[React frontend] --> API[Hono API]
    API --> DB[(Videos, courses, and users)]
    API --> Queue[Job queue]
    Queue --> Worker[Python video processing]
    Worker --> DB
```

The frontend fetches state from the API. Once the worker saves transcripts and indexes, the frontend can use those results.

## Responsibilities of the three apps

| App | Responsibility | Main code |
|---|---|---|
| Web | Display, forms, question input, and playback | `apps/web/src/` |
| API | Authentication, access control, business logic, and job requests | `apps/api/src/` |
| Python worker | Transcription and indexing | `apps/worker/worker_python/` |

Web and API share operation names and input/output types through `packages/trpc`. SQS JSON messages and the database form the boundary with Python.

## Local and production equivalents

| Role | Local | Production |
|---|---|---|
| Frontend | Static nginx build or Vite | Cloudflare Workers Static Assets |
| API | Wrangler development server | Cloudflare Workers |
| Database | PostgreSQL + pgvector | Cloudflare D1 + Vectorize |
| API-to-DB connection | Local connection string | D1 / Vectorize bindings |
| Video, subtitle, and other storage | Garage | Cloudflare R2 |
| Job queue | ElasticMQ | Amazon SQS |
| Python worker | Container continuously polling the queue | AWS Lambda triggered by SQS |
| Temporary API state | Local Durable Objects | Cloudflare Durable Objects |

Locally, Caddy routes `http://localhost` to the frontend and API. Development Vite uses port 3000, and the documentation site uses 3001.

## Production layout

```mermaid
flowchart TB
    User[Browser] --> Web[Cloudflare Workers Static Assets]
    User --> API[Cloudflare Workers / Hono]
    API --> DB[(Cloudflare D1)]
    API --> Vectors[(Vectorize)]
    API --> R2[(Cloudflare R2)]
    API --> DO[Durable Objects]
    API --> Queue[Amazon SQS]
    Queue --> Worker[Python / AWS Lambda]
    Worker --> R2
    Worker -->|Internal persistence API|API
    Worker -->|GetWebIdentityToken|STS[AWS STS]
    STS -->|Short-lived JWT|Worker
    Worker -->|JWT for inference|API
    API -->|AI binding|AI[Workers AI]
    API --> Mail[Mailgun]
```

The hosted API uses D1 and Vectorize bindings; Lambda persists data through the internal API. On-premises uses PostgreSQL and pgvector.

API answers and query embeddings use the native AI binding. Lambda transcription and document embeddings present a short-lived AWS JWT to the API Worker before it calls the same binding. OpenRouter and AI Gateway are not in this path. See the [cloud AI runbook](https://github.com/videoq-jp/videoq/blob/main/docs/operations/openai-transcription.md) and [on-premises layout](../guides/on-premises.md).

## Durable Object roles

- `RATE_LIMITER`: Limits excessive requests over short periods.
- `TASK_SCHEDULER`: Schedules recovery of undelivered jobs and abandoned uploads.
- `CHAT_EXECUTION`: Runs each chat answer in its own SQLite-backed object, so long tool loops do not depend on the ordinary Worker CPU limit. See [answer streaming troubleshooting](../guides/troubleshooting.md#answer-streaming-fails-or-citations-arrive-later).

Recovery is scheduled with Durable Object alarms. The current cron schedule is daily at `17 3 * * *` (UTC), for cleanup and recovery. Do not assume a five-minute cron schedule.

The implementation entry point is [app.ts](https://github.com/videoq-jp/videoq/blob/main/apps/api/src/app.ts), and runtime configuration is in [wrangler.jsonc](https://github.com/videoq-jp/videoq/blob/main/apps/api/wrangler.jsonc).

**Read next:** [Find your way around the code](../getting-started/codebase.md), [Job delivery and recovery](flowchart.md).
