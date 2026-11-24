---
title: Troubleshooting
description: Where to look when startup, login, video processing, or search fails.
---

# Troubleshooting

First identify which parts are working: frontend, API, database, and video processing. You do not need to recreate the database as a first step.

## Three things to check first

```bash
docker compose ps -a
docker compose logs --tail=100 migrate api worker
curl -i http://localhost/ready
```

Exit code `0` for `migrate` and `garage-init` is normal. If `/health` succeeds but `/ready` fails, the API is responding; check DB connectivity and migrations next.

## The UI does not open or reflect changes

| Symptom | What to check |
|---|---|
| `localhost` does not open | Whether `gateway` and `web` are running, and whether another app uses port 80 |
| The UI opens but API calls fail | `/health`, `/ready`, and `api` logs |
| Edits do not appear | `localhost` serves a static build. Start `web-dev` and open `localhost:3000` |
| The server cannot start on port 3000 | Whether Compose's `web-dev` and host Vite are both running |
| Documentation search does not work | Run `npm run build:docs`, then check with `npm run preview:docs` |

## Login fails

In a local environment without email configured, check the [account promotion step in setup](../getting-started/local-setup.md). You must sign up before the account can be promoted.

For migrated local accounts showing `Password not found`, use this recovery command:

```bash
read -rsp 'New local password (12–128 characters): ' VIDEOQ_LOCAL_PASSWORD
echo
export VIDEOQ_LOCAL_PASSWORD
npm run user:password:local --workspace @videoq/api -- your-username
unset VIDEOQ_LOCAL_PASSWORD
```

Run these commands in Bash. The password is read without echo and is never logged. Do not apply this procedure directly to shared or production login issues.

If login attempts hit the local rate limit, stop the API, reset the RateLimiter's local state, and restart the API. See [reset-rate-limit.sh](https://github.com/videoq-jp/videoq/blob/main/apps/api/scripts/reset-rate-limit.sh) for its requirements.

## Video processing is stuck

Record the video ID and status, then inspect the `worker` logs.

| State or symptom | What to check |
|---|---|
| Stuck in `uploading` | Browser-to-Garage upload, port 9000, and the upload completion notification |
| Stuck in `pending` | Whether `worker` and `elasticmq` are running, and API job delivery logs |
| Failure during `processing` | Audio availability, FFmpeg/Whisper logs, and AI keys |
| Failure during `indexing` | Embedding model and dimensions, DB connectivity, and worker exceptions |
| Only YouTube imports fail | The TranscriptAPI key in settings and subtitles for the requested video |
| Rejected for size or usage | Upload limits, storage capacity, and monthly usage in Admin |

See [video state transitions](../design/state-diagram.md) for the meaning of each state.

## Search fails or answers have no citations

1. Check that the course you are asking about contains the video.
2. Check that the video is `completed` and has a transcript.
3. Compare API and worker `EMBEDDING_BASE_URL` / `EMBEDDING_MODEL` using the [embedding diagnostic commands](embeddings.md). Dimensions are fixed at 1536. Check the logged reason for configuration, schema, or output errors.
4. If the embedding model changed, follow the [existing-data migration constraints](embeddings.md#model-consistency). Matching dimensions alone do not make old vectors compatible; a full reindex replaces videos individually and can leave mixed models after partial failure.

Questions about course names or video counts may be answered from metadata without scene citations. Even content questions may not produce the expected answer if the video contains no supporting evidence.

## Answer streaming fails or citations arrive later

ReAct chat runs in a separate `CHAT_EXECUTION` Durable Object for each answer. The edge Worker forwards the original request and streams the response without parsing it. Authentication, course access, quota reservation, tools, and final answer persistence still run through the same API handlers. Both SSE and the `chat.send` tRPC procedure use this execution path, including batches containing `chat.send`.

Workers Free has a **10 ms CPU limit** for ordinary requests; SQLite-backed Durable Objects have a **30 second CPU limit** by default. These measure active processing, not time waiting for the model. A long tool loop cannot reliably run in the ordinary Free Worker. No paid subscription or database migration is required for this path; Wrangler creates the new SQLite-backed class during deployment. See Cloudflare's [Worker limits](https://developers.cloudflare.com/workers/platform/limits/#cpu-time), [Durable Object limits](https://developers.cloudflare.com/durable-objects/platform/limits/), and [free daily quotas](https://developers.cloudflare.com/durable-objects/platform/pricing/). Exceeding a free daily quota stops operations until it resets; the free plan does not charge overages.

If a response is HTML or stops abruptly, inspect the failing invocation in Cloudflare **Workers & Pages → API Worker → Observability → Events**. `Worker exceeded CPU time limit` / `exceededCpu` means the runtime terminated it, possibly before the application's error handler ran. Check both the edge invocation and the `ChatExecution` invocation. Verify an actual tool-using answer reaches `done` and appears in history; `/health` does not test this path. Other API routes still run in the ordinary Worker and must be diagnosed separately if they exceed its CPU limit.

| Symptom | What to check |
|---|---|
| `LLM_CONFIGURATION_ERROR` | The API's server key and whether the configured endpoint/model supports strict `json_schema` output together with strict function tools |
| Search progress appears before text | Retrieval precedes answer generation; tool-call preambles are intentionally omitted |
| A citation arrives after its passage | The segment must close and its source IDs and math/code boundary must be validated |
| Text appears, then the request fails | Provider refusal, output-token truncation, invalid final JSON, a tool call after answer text, or an interrupted stream; partial display is not a saved answer |
| No saved history or feedback after text finishes | Check final validation and persistence; SSE must receive `done`, then drain the rendering queue |

The browser uses animation frames rather than a fixed typing timer. `done` marks answer persistence. See [the streaming contract](../architecture/prompt-engineering.md#streaming-contract) for event order and quota handling.


## A corrected transcript still gives old answers

Saving subtitles and completing their asynchronous search reindex are separate events. The video's existing `completed` label does not confirm an edit's reindex finished. Check the matching worker job, then send a new Q&A question; previously displayed or saved answers stay unchanged.

## Configuration changes have no effect

Changes to Compose's `.env` do not automatically reach running processes:

```bash
docker compose up -d --force-recreate api worker
```

The variables forwarded to the API are limited by [docker-dev.sh](https://github.com/videoq-jp/videoq/blob/main/apps/api/scripts/docker-dev.sh). Adding an arbitrary variable to `.env` may not make it available to the API.

## Ask the team for help

Share the operation you tried, screen URL, video ID, expected result, actual state, and relevant log timestamps or request IDs. Remove keys, cookies, and users' private data from logs before sharing them.
