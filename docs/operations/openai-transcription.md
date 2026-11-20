# Cloud inference: Workers AI

The selected cloud stack uses Workers AI directly, without AI Gateway or
OpenRouter in the production inference path.

| Purpose | Fixed model | Authentication |
| --- | --- | --- |
| Answers and image/slide reading | `@cf/google/gemma-4-26b-a4b-it` | API Worker's native `AI` binding |
| Query and document embeddings | `@cf/google/embeddinggemma-2` (768d) | Binding for queries; AWS federation for Lambda documents |
| Transcription | `@cf/openai/whisper-large-v3-turbo` | AWS federation from Lambda to the API Worker |

This file describes the target configuration and controlled rollout. Deployment
status must be confirmed from successful CD/Terraform runs and runtime checks;
committing these settings alone does not establish a completed cutover.

## Authentication boundary

Lambda obtains a short-lived AWS STS `GetWebIdentityToken` JWT using its execution
role. The single audience is `https://videoq.jp/api/internal/workers-ai`.
It sends that JWT to `/api/internal/workers-ai/transcribe` or `/embeddings`.
The Worker verifies AWS JWKS signatures, pinned issuer, exact IAM role subject,
audience, issued-at, not-before and expiry; only RS256 and at most 900 seconds
are accepted. It then calls the fixed model using `env.AI.run()`.
This is application workload federation, not native AWS-JWT authentication at
the public Workers AI REST endpoint. Lambda stores no Cloudflare inference key.

A shared Durable Object rate limit permits 120 inference requests/minute per
verified role, across tokens/isolates. Authentication precedes body parsing;
missing trust/binding/limiter fails closed. Models cannot be selected by callers.
Audio is capped at 4 MiB and processed in 300-second compressed chunks.
Embedding batches contain at most 32 nonempty bounded texts. Provider errors
are sanitized and do not trigger fallback to another inference provider.

The issuer and exact role are pinned in production Wrangler vars. Terraform
configures the same audience, signing algorithm and TTL. The independent
maintenance Terraform root owns the worker permissions boundary; an operator
must review/apply only `aws_iam_policy.worker_boundary`. Routine GitHub deploys
cannot edit that ceiling.

## Chat protocol and embedding contract

The OpenAI-compatible SDK transport uses the native binding in-process; its
`.invalid` URL is a sentinel and is never fetched over the public network.
Gemma's thinking is disabled. Tool decisions are separate from final JSON
grammar. The final schema is supplied as both a constraint and an instruction,
preventing required-key/whitespace loops. Stream usage summaries are normalized
without buffering the answer. Refusals and incomplete JSON still fail closed.

EmbeddingGemma 2 uses exactly 768 finite nonzero float32-compatible dimensions.
Queries receive `task: search result | query: ` and documents receive
`title: none | text: `, once. API and Lambda must select the same model, profile
and preprocessing. Never truncate, pad or mix existing 1536d vectors into this
space. Existing transcripts are retained.

## Staged deployment

1. Merge a protected PR with passing required checks. Deploy native Gemma chat,
   the federation routes, worker adapters and both Vectorize bindings. Initially
   retain legacy 1536d query configuration while the new index is populated.
   Before inserting vectors, create the 768d cosine index
   `videoq-prod-scenes-embeddinggemma2-768` and its metadata indexes:
   `user_id` (string), `video_id` (number), and `vector_id` (string).
   Synchronization verifies ANN visibility using all three filters; creating
   only the vector index cannot establish readiness.

   The existing deployment guard rejects adding or replacing a Vectorize binding
   through ordinary CD. Before this first deployment, attach
   `SCENE_VECTORIZE_768` to the approved new index as a controlled preparation
   operation. Snapshot current settings, confirm the latest uploaded version is
   the sole active version, and use the
   [settings PATCH API](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/script_and_version_settings/methods/edit/)
   with `type: inherit` for every existing binding plus the one new Vectorize
   binding. Verify that all previous bindings (including secrets), DB identity,
   query model/profile and other settings are unchanged. Keep 1536d queries
   active. If the binding already matches, no preparation write is needed; a
   mismatched existing binding requires its own controlled migration. Preserve
   the deployment guard, then run or retry ordinary CD.
2. Confirm API CD and all three worker images completed. Review the independent
   worker-boundary plan (only the exact audience changes), then approve the
   production Terraform switch to Workers AI transcription and 768d documents.
3. Snapshot completed-video IDs/revisions. Enqueue normal individual
   `reindex_video_transcript` jobs on the search queue using stable job IDs.
   Start with one completed canary video and verify federation, embeddings and
   768d vector delivery before scheduling the remaining videos with spacing
   below the shared inference rate limit.
   The full-reindex dispatcher deliberately rejects a configuration that differs
   from the query configuration during staging; do not weaken that guard.
4. Verify every current completed transcript has a published 768d head and that
   vector upserts are accepted/completed. Confirm representative vector IDs are
   present in `videoq-prod-scenes-embeddinggemma2-768`. Re-enqueue any changed
   transcripts, and recheck coverage before switching queries.
5. Deploy the second protected change selecting Workers AI embeddings in the API
   and remove the legacy endpoint/federation configuration. Keep the old index
   until migration and rollback requirements are satisfied.
6. Use an ordinary disposable video upload to verify transcription, indexing,
   Japanese retrieval, structured and streaming cited answers, slide reading
   and timestamp playback. Reject missing/incorrect-role tokens. Delete only
   the disposable verification media after recording the outcome.
7. Retire obsolete inference secrets and STS/OpenRouter permissions once all
   cloud inference paths have passed. Keep AWS/S3/queue credentials required for
   storage and jobs. Do not delete unrelated account resources.

For rollback, use a reviewed protected change restoring the previous matching
API/worker model, profile, IAM audience and permissions boundary together.
Changing only the Whisper backend is insufficient. Preserve previous vectors
and transcripts, and reindex videos changed since the rollback snapshot.

## On-premises

On-premises uses private OpenAI-compatible Gemma 4/EmbeddingGemma 2 endpoints and
local Whisper; AWS federation and Cloudflare bindings are unnecessary there.
See [local inference](../guides/local-inference.md) and the
[RTX 4090 CPU-offload candidate](../guides/rtx4090.md). Real GPU/site acceptance
remains separate from distribution configuration checks.

The earlier [Cloudflare pilot](cloudflare-ai-pilot.md) is historical evaluation,
not the production authentication procedure or an accuracy guarantee. Whisper
preprocessing can differ across providers; technical terms still need review.
