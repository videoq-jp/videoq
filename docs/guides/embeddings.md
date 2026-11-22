---
title: Configure and verify embeddings
description: Embedding profiles, Workers AI setup, diagnostics, and model consistency.
---

# Configure and verify embeddings

The default API and Python worker profile uses 1536 dimensions. The explicit
`embeddinggemma2` profile uses 768 dimensions; both runtimes validate the selected
storage and output contract.

## Choose a hosted or private endpoint

VideoQ uses the OpenAI-compatible embeddings protocol. Templates, Compose and
Wrangler default to:

```dotenv
OPENAI_BASE_URL=https://openrouter.ai/api/v1
EMBEDDING_MODEL=openai/text-embedding-3-small
```

Set `OPENROUTER_API_KEY` in both API and worker environments. The model remains OpenAI text-embedding-3-small with 1536 dimensions; the OpenRouter namespace alone does not require reindexing. A private llama.cpp or vLLM service uses
the same protocol, its own model alias and an explicit endpoint, for example:

```dotenv
EMBEDDING_BASE_URL=http://embedding.intranet:8000/v1
EMBEDDING_API_KEY=local-inference
EMBEDDING_MODEL=gte-qwen2-1.5b-q4km-124fbdad
```

`EMBEDDING_API_KEY` falls back to the key for the selected endpoint (`OPENROUTER_API_KEY` on OpenRouter, otherwise `OPENAI_API_KEY`); use a placeholder only when
the private server has no authentication. `EMBEDDING_BASE_URL` falls back to
`OPENAI_BASE_URL` when empty, so set it explicitly for a separate embedding
service. The API and worker must use the same model/endpoint. With Compose and a
host-side server, use `http://host.docker.internal:8001/v1` if that server listens
on port 8001. Chat and Whisper have independent settings; see [local AI inference](local-inference.md).

Requests use `POST /v1/embeddings` with `dimensions: 1536`, `encoding_format: float`,
model and input. The llama.cpp profile uses native 1536-dimensional gte-Qwen2;
vLLM uses Qwen3-Embedding-4B with reduced output explicitly enabled. The
application rejects incompatible output without truncating, padding, retrying
without dimensions or choosing a hosted fallback.

The protocol is fixed. Model names are trimmed but retain their case; an empty
model uses `text-embedding-3-small` (qualified as `openai/text-embedding-3-small` on OpenRouter). Private installations set their actual served
alias and endpoint in both API and worker.

For attribution, see [OpenAI embeddings](../reference/ai-references.md#openai-embeddings)
and [Qwen3 Embedding](../reference/ai-references.md#qwen3-embedding) when that family
is used. Record the actual weight revision, quantization and serving image.

## Opt in to Workers AI EmbeddingGemma 2

The hosted default remains unchanged. To prepare a separate 768-dimensional
EmbeddingGemma 2 corpus, configure the API and ingestion worker consistently:

```dotenv
EMBEDDING_PROVIDER=workers-ai
EMBEDDING_PROFILE=embeddinggemma2
EMBEDDING_MODEL=@cf/google/embeddinggemma-2
```

The API requires its Cloudflare `AI` binding. It uses LangChain
`OpenAIEmbeddings` with a temporary binding transport; no OpenAI or Cloudflare API
key is sent for these inference calls. Replace this transport with the official
Cloudflare embeddings integration once its model support is released. LangChain
handles batching (32 inputs) and concurrency (2); the application keeps its
30-second deadline, caller cancellation and 768-dimensional vector validation.
There are no automatic retries or alternate-provider fallbacks.

Queries receive `task: search result | query: ` and documents receive
`title: none | text: ` exactly once in the API. The ingestion worker sends raw
text through the authenticated internal API rather than adding another prefix.
Set `WORKER_INTERNAL_API_ORIGIN` and `WORKER_INTERNAL_API_SECRET` in the Python
worker, and the same `WORKER_INTERNAL_API_SECRET` in the API, using the existing
worker authentication configuration. `POST /internal/worker/embeddings/generate`
accepts at most 32 texts (16,000 characters each) per signed request; model,
profile and dimensions must match the API configuration before inference runs.
The worker batches requests and validates returned model metadata and vectors.
No new Cloudflare token is required by the Python worker.

Upstream tracking: [LangChain JS #12285](https://github.com/langchain-ai/langchainjs/pull/12285)
and [LangChain Python #103](https://github.com/cloudflare/langchain-cloudflare/pull/103).

**Do not switch an existing corpus merely because it has 768 dimensions.** The
existing local EmbeddingGemma profile also uses the 768-dimensional storage
slot; equal dimensions do not prove compatible model revisions or input formats.
Provision and fully populate a separate evaluation index/storage environment,
record the model and input format, compare retrieval quality, and coordinate the
query and ingestion configuration before switching traffic. This setting adds
an opt-in generation path; it does not migrate existing vectors or activate a
production cutover.

## What gets checked

Before scene search or indexing, the PostgreSQL path verifies the declared DB column matches the selected profile (`vector(1536)` by default, `vector(768)` for `embeddinggemma2`), including when the table is empty. A missing column, another type, or an unbounded `vector` column fails validation.

Every generated vector must contain exactly the selected profile’s number of finite numeric values, fit pgvector's float32 representation, and remain nonzero. Strings and booleans are rejected. Batch counts and OpenAI response indices must match the inputs.

Scene splitting uses output validation without requiring a DB for standalone calculations. Contract errors propagate instead of silently producing fallback scenes. Pure data deletion requires no model call or credentials.

Full reindexing checks the DB embedding contract when there are eligible videos, then generates and validates **all replacement embeddings for one video before changing that video's rows**. It locks the current video row, rechecks the transcript, and replaces the rows in a single transaction. A failed video retains its old index while other videos can finish; the job reports failure for retry if any video failed. There is no initial deletion of the entire index and no separate short probe in this job. Use the explicit `--probe` diagnostics below when needed. The operation is atomic per video, not across the full collection.

## Compare API and worker diagnostics

Use the effective model/endpoint settings for each runtime and a `DATABASE_URL` pointing to its database. The commands below run from the API and worker directories respectively. The API command can load a dotenv file through `DOTENV_CONFIG_PATH`; the Python command reads exported environment variables.

```bash
# apps/api: settings and declared DB type only
npm run embeddings:check
# apps/worker: use your installed worker environment
python -m worker_python.check_embeddings
```

To additionally call the configured model with a short diagnostic input, explicitly opt in (external API charges may apply):

```bash
# apps/api
npm run embeddings:check -- --probe
# apps/worker
python -m worker_python.check_embeddings --probe
```

Successful DB validation emits JSON such as:

```json
{"event":"embedding.validation","provider":"openai","model":"text-embedding-3-small","expected_dimensions":1536,"db_dimensions":1536}
```

The probe additionally reports `actual_dimensions`. Compare `provider`, `model`, and dimension fields across both runtimes. Logs omit credentials, connection strings, input text, and vectors. Startup and health checks do not generate paid embeddings.

| Internal reason | Meaning |
|---|---|
| `EMBEDDING_CONFIG_INVALID` | A worker embedding request rejected with HTTP 4xx (except 408/429) |
| `EMBEDDING_SCHEMA_MISMATCH` | DB declaration differs from `vector(1536)` |
| `EMBEDDING_OUTPUT_INVALID` | Invalid model output, count, or indices |

Q&A keeps its existing public errors: configuration/schema errors use HTTP 400 `VALIDATION_ERROR` or SSE `LLM_CONFIGURATION_ERROR`; output errors use HTTP 500 `INTERNAL_ERROR` or SSE `LLM_PROVIDER_ERROR`. Failed answers release reserved quota. Worker jobs use the existing failure/retry handling.

The worker propagates permanent provider rejections, including unsupported models or dimensions, through scene splitting. It does not log the provider's response body. Timeouts, rate limits, and server failures retain the existing best-effort fallback in scene splitting.

## Model consistency

All stored vectors and query vectors must use the same weights, revision,
quantization, pooling and preprocessing. Equal dimensions do not establish a
shared vector space. Saved rows do not record this provenance, so record the
chosen configuration and verify API/worker diagnostics together.

For a new deployment, initialize the database with the chosen model settings.
When changing models later, stop Q&A/indexing and rebuild the scene vectors
before resuming searches. Do not mix vectors from different model versions.
The default profile uses 1536 dimensions; `embeddinggemma2` uses its separate 768-dimensional storage.

## TypeScript background processing

Search indexing and account deletion now have shared TypeScript implementations.
Cloud deployments can use Cloudflare Queues and `SearchIndexWorkflow`; on-premises
runs `node dist/background-worker.mjs` from the API image against dedicated
SQS-compatible search and account queues. Video/audio preparation remains in the
Python media worker.

The PostgreSQL writer uses `@yukiharada1228/langchain-postgres` with a pinned
transaction client. Provider calls finish before the write transaction. The
writer rechecks ownership and the exact subtitle snapshot under a row lock,
replaces all scenes atomically, and rolls back every change on failure.

Cloud indexing retains the existing revision-fenced D1 staging and Vectorize
publication. Workflows saves source snapshots and exact embedding batches under
`internal/search-index/` in R2; durable step outputs carry references rather than
whole transcripts or vectors. Successful jobs delete those intermediate objects.
Failed jobs retain them for recovery; do not delete them while a workflow is live.
Exhausted workflows send their original job identity and workflow ID to
`SEARCH_FAILURES` (the search DLQ), separately from queue-delivery failures.
Scene-splitting embedding batches are checkpointed separately as well, so long
subtitles do not require repeating every model call after interruption.

Cloud transport remains gated by `ACCOUNT_JOB_BACKEND` and `SEARCH_JOB_BACKEND`.
The default is `sqs` during rollout; switching a group to `cloudflare` requires
its queue binding and verified consumers. Delivery failures stay in the durable
outbox and never silently fall back to a different transport. The Python media
worker uses the signed `/internal/worker/jobs/enqueue` endpoint when
`SEARCH_JOB_BACKEND=cloudflare`, preserving its stable child job identity.
