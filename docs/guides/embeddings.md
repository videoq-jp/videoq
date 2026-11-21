---
title: Configure and verify embeddings
description: The fixed 1536-dimensional contract, model/endpoint settings, diagnostics, and model consistency.
---

# Configure and verify embeddings

VideoQ stores scene embeddings in `scene_embeddings.embedding vector(1536)`. The API and Python worker use a fixed `EMBEDDING_DIMENSIONS = 1536` constant. Both runtimes validate the same fixed storage and output contract.

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

## What gets checked

Before scene search or indexing, the relevant path verifies the declared DB column is `vector(1536)`, including when the table is empty. A missing column, another type, or an unbounded `vector` column fails validation.

Every generated vector must contain exactly 1536 finite numeric values, fit pgvector's float32 representation, and remain nonzero. Strings and booleans are rejected. Batch counts and OpenAI response indices must match the inputs.

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
The current application and database require exactly 1536 dimensions.
