---
title: Glossary
description: Abbreviations and terminology in VideoQ, explained through their role in the project.
---

# Glossary

You do not need to memorize everything. Use this page to connect unfamiliar terms with their role in the project.

| Term | Meaning in VideoQ |
|---|---|
| API | Receives requests from the UI or external tools, checks permissions, and returns data or processing results |
| Hono | The framework for HTTP requests and shared API middleware |
| tRPC / procedure | An API mechanism sharing TypeScript types / one operation such as `videos.get` |
| Zod | A library for validating the shapes of inputs and outputs |
| TanStack Query | Manages frontend data fetching, caching, loading, and error states |
| Drizzle / migration | Tools for DB definitions and queries / a recorded change to DB structure or data |
| Repository | Code that groups DB reads and writes; distinct from a Git repository |
| Service | Business logic coordinating permission checks, DB operations, and external services |
| Cloudflare Workers | The production runtime for the Hono API |
| Python worker | The asynchronous processing program in `apps/worker`, handling transcription and other jobs |
| SQS / ElasticMQ | The job queue / an SQS-compatible local queue |
| R2 / Garage | Storage for video files and other objects / compatible local storage |
| Neon / PostgreSQL | The production database service / its underlying database |
| Hyperdrive | Connects Cloudflare Workers to PostgreSQL |
| Durable Object (DO) | A stateful Cloudflare execution unit, used for rate limits, job recovery scheduling, and running chat answers |
| Embedding | A numeric array for comparing text meaning. API questions and worker subtitles must use the same model and dimensions |
| pgvector | A PostgreSQL extension for storing and searching embeddings |
| RAG | Retrieval-augmented generation: finding relevant material before producing an answer. VideoQ refers to video subtitles and metadata |
| LLM | A language model used to generate answers |
| OpenRouter | The hosted gateway for answers, image inspection, embeddings, and transcription. Private servers can replace it on-premises |
| Workload identity federation | Lets a workload call OpenRouter with its AWS identity instead of a stored API key |
| Agent / tool call | The answer model chooses a registered operation, such as course metadata or scene search; the API validates and executes it within the authorized scope |
| Structured answer / `ChatAnswer` | The shared answer format: `segments` pair text with source IDs, while `sources` contains server-owned video and timestamp metadata |
| Outbox | Records jobs awaiting delivery in the same DB as business data, enabling recovery from missed dispatches |
| Idempotency | The property of avoiding unintended duplicates or other effects when repeating an operation |
| Lease | A time-limited right to execute work, allowing retries after a process stops |
| SSE | Server-Sent Events: streams data from the server to the browser for incremental chat answers |
| MCP | A protocol that lets external clients such as AI assistants call tools |
| OAuth / scope | A mechanism for authorizing external client access / the range of permitted operations |
| Quota | Usage limits such as storage capacity, video processing time, and AI answer counts |

**Read next:** [Videos, courses, and scenes](../concepts/domain-model.md), [Find your way around the code](../getting-started/codebase.md).
