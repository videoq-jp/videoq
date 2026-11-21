---
title: Configure and verify embeddings
description: The selected 768-dimensional EmbeddingGemma 2 contract, legacy 1536-dimensional profiles, diagnostics, and migration.
---

# Configure and verify embeddings

The selected cloud and on-premises model is EmbeddingGemma 2 with 768 dimensions.
The API and Python worker must use the same model, profile and preprocessing.
Legacy 1536-dimensional indexes remain separate for compatible older installations
and rollback; equal dimensions alone do not establish a shared vector space.

| Profile | Dimensions | Storage |
|---|---|---|
| Hosted Workers AI / `embeddinggemma2` | 768 | D1 scenes and `videoq-prod-scenes-embeddinggemma2-768` in Vectorize |
| Private EmbeddingGemma 2 / `embeddinggemma2` | 768 | PostgreSQL `scene_embeddings_768.embedding vector(768)` |
| Explicit legacy `openai` profile | 1536 | PostgreSQL `scene_embeddings.embedding vector(1536)` or the retained legacy cloud index |

## Choose a hosted or private endpoint

The hosted API uses its native Cloudflare AI binding:

```dotenv
AI_PROVIDER=workers-ai
EMBEDDING_PROFILE=embeddinggemma2
EMBEDDING_MODEL=@cf/google/embeddinggemma-2
```

Lambda document indexing obtains a short-lived AWS workload JWT and sends it to
the API Worker's fixed embedding route. No Cloudflare inference key, OpenRouter
or AI Gateway is used. See the [hosted rollout procedure](https://github.com/videoq-jp/videoq/blob/main/docs/operations/openai-transcription.md).

For the private vLLM service, configure both API and worker:

```dotenv
AI_PROVIDER=openai
EMBEDDING_PROFILE=embeddinggemma2
EMBEDDING_MODEL=embeddinggemma-2-f9972ac
EMBEDDING_BASE_URL=http://embedding.intranet:8000/v1
EMBEDDING_API_KEY=local-inference
```

Here `openai` selects the compatible wire protocol. Use the placeholder key only
when authentication is disabled on the private server; otherwise provide its real
credential through the runtime Secret. Set the dedicated embedding endpoint
explicitly. For a host-side service on port 8001 with Compose, use
`http://host.docker.internal:8001/v1`. Leave `PGVECTOR_COLLECTION_NAME` unset to
select the profile's table automatically. Chat and speech use separate settings;
see [local inference](local-inference.md).

Queries receive `task: search result | query: `; documents receive
`title: none | text: `, once. The private EmbeddingGemma 2 request omits an OpenAI
`dimensions` override and validates its native 768-dimensional result. The native
Workers AI binding explicitly selects 768 dimensions. Legacy llama.cpp/GTE and
Qwen profiles explicitly select `EMBEDDING_PROFILE=openai` and 1536 dimensions.

## What gets checked

PostgreSQL diagnostics validate the declared column against the selected profile,
even when empty. Missing columns, unbounded vectors or a different dimension fail.
Each output must have exactly the selected number of finite float32-compatible
numeric values and remain nonzero. Batch counts and response indices must match.
The application never truncates, pads, mixes spaces or falls back to another
provider to repair an incompatible result.

Reindexing preserves the saved transcript. PostgreSQL replaces a video's rows
atomically after generating its replacement vectors. Hosted indexing uses fenced
staged runs and immutable vector IDs, then verifies filtered ANN visibility before
completion. A saved vector or an accepted upsert alone does not prove readiness.

## Compare API and worker diagnostics

For on-premises PostgreSQL, export matching model/profile/endpoint settings and a
`DATABASE_URL`. Run these from the API and worker directories respectively:

```bash
npm run embeddings:check
python -m worker_python.check_embeddings
```

To call the configured private model as well, add `--probe` (for npm, use
`npm run embeddings:check -- --probe`). The API script can load a dotenv file via
`DOTENV_CONFIG_PATH`. The Python script reads exported variables. These Node/Python
diagnostics do not provide a Workers AI binding; verify hosted inference in the
Worker runtime and through the rollout's normal Lambda jobs.

A private Gemma profile reports `expected_dimensions: 768` and `db_dimensions: 768`.
Compare provider, model, profile and dimension fields across both runtimes. Logs
omit credentials, connection strings, input text and vectors. Health checks do not
generate paid embeddings.

| Internal reason | Meaning |
|---|---|
| `EMBEDDING_CONFIG_INVALID` | Invalid profile/endpoint or a permanent provider rejection |
| `EMBEDDING_SCHEMA_MISMATCH` | DB declaration differs from the selected profile |
| `EMBEDDING_OUTPUT_INVALID` | Invalid vector values, count or response indices |

Failed answers release reserved quota. Worker jobs use their normal retry handling.
Contract errors propagate through scene splitting. Timeouts, rate limits and server
failures retain its existing best-effort fallback, without switching providers.

## Model consistency

Record weights/revision, quantization, pooling and preprocessing for private
services, and the fixed hosted model identifier for Workers AI. New deployments
start with the selected profile. Existing installations must rebuild all searched
material before changing the query model. The hosted rollout retains the old
1536-dimensional index while backfilling 768 dimensions and switches queries only
after current-source coverage and vector visibility are verified. Never combine
old and new vectors by truncating or padding them.
