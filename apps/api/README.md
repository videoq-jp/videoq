# apps/api

VideoQ's Web API, built with Hono / TypeScript and running on Cloudflare Workers.

The production on-prem entrypoint runs the same Hono app on Node.js, without
Wrangler or Durable Objects. For installation, use the
[single-server guide](../../docs/guides/on-premises-single-server.md) or
[Helm chart](../../charts/videoq/README.md). For runtime development, build with `npm run build:node`, then run
`npm run start:node` with the required settings from the
[Helm chart README](../../charts/videoq/README.md). The same image provides
`node dist/node.mjs maintenance` and `node dist/node.mjs retention` for CronJobs.

New contributors should start with [development environment setup](../../docs/getting-started/local-setup.md).
For API changes, start with the [API development guide](../../docs/guides/api.md).
The following reference covers details specific to the API package.

## Structure

The router in `packages/trpc` is the source of truth for the regular JSON API.
The API workspace implements request context and service adapters.

```text
src/
├── app.ts                 # Assemble Hono, tRPC, and raw transports
├── index.ts               # fetch / scheduled entrypoint
├── trpc/
│   ├── context.ts         # request-scoped auth / procedure adapter
│   └── handlers/          # Connect domain services to procedures
├── features/
│   └── <domain>/
│       ├── routes.ts      # Protocol-specific HTTP endpoints only
│       ├── schemas.ts     # Zod schemas for raw transports
│       └── service.ts     # use case orchestration
├── application/           # Transport-independent models, failures and proof types
├── repositories/          # Compatibility facades over persistence contracts
├── persistence/
│   ├── contracts/         # Backend-independent persistence capabilities
│   ├── d1/                # D1 implementations
│   ├── postgres/          # PostgreSQL implementations
│   └── factory.ts         # Backend selection
├── integrations/          # External adapters and runtime composition
├── db/schema/modern.ts    # Source of truth for the runtime schema
├── middleware/            # auth, CORS, error handling
├── shared/                # Errors, pagination, dates, etc.
└── lib/                   # JWT, passwords, OAuth, SQS, encryption, etc.
```

Requests flow from `tRPC router → handler → integration → service → repository port`.
In the extracted workflows, source dependencies point inward: services import contracts, while integrations
select implementations and supply runtime configuration. A service does not
construct its own database or provider client.
Input validation and procedure names are centralized in `packages/trpc/src/routers`.

The API uses incremental separation rather than requiring every feature to follow
an identical set of layers:

- `features/qa/policy.ts` owns the shared access and mutation rules. PostgreSQL
  evaluates these rules on transaction-scoped facts; D1 composes them into SQL
  predicates inside its atomic batch. Session validity, membership, current video
  scope, locking and audit writes remain in the persistence implementations.
  Displayed edit/delete capabilities use the same policy as mutations.
  `features/qa/core.ts` accepts a `QaRepository`; `integrations/qa.ts` selects the
  implementation for HTTP/tRPC callers. Q&A input, result and command types live
  in `persistence/contracts/qa-repository.ts` without importing tRPC types.
  Transport handlers connect the structurally compatible API schemas to these
  internal types; API typechecking checks that connection.
- `features/videos/upload-service.ts` owns the upload lifecycle and accepts
  `VideoUploadDependencies`, with no `Bindings` or concrete adapters. The
  request-local `integrations/video-upload.ts` assembles persistence, media,
  multipart and task adapters. `features/videos/upload-http.ts` parses raw forms
  and converts direct-upload failures into the existing HTTP status/error envelope.
  The lifecycle accepts a streaming file capability rather than a `File`/form and
  returns application outcomes without HTTP statuses. Existing service functions
  preserve tRPC and MCP callers. Reservation/confirmation/deletion and outbox creation remain atomic
  persistence operations; task delivery follows the committed operation.
- `features/videos/management-service.ts` accepts `VideoManagementDependencies`
  for listing, YouTube creation, transcript updates and deletion. The request-local
  `integrations/video-management.ts` supplies persistence, validation, storage and
  task capabilities. `features/videos/service.ts` retains compatibility entrypoints.
  Authorization, writes and outbox creation remain atomic in persistence; delivery
  follows the committed operation.
- `features/membership/core.ts` accepts a `MembershipRepository`. Its integration
  supplies the existing atomic membership operations; insertion counts and reuse
  outcomes come from the committed operation, not a preceding read.
- `features/courses/service.ts` accepts a `CourseRepository` through
  `createCourseService`. `integrations/courses.ts` supplies the selected backend
  to HTTP/tRPC and MCP callers. Share-link validation and idempotent creation
  run without runtime bindings.
- `features/chat/service.ts` and `conversation-service.ts` accept persistence,
  course access and feedback-token capabilities. `integrations/chat-history.ts`
  and `integrations/conversations.ts` supply the implementations. Conversation
  reads use `persistence/contracts/conversation-read.ts`; checkpoint and LangGraph
  types remain in the separate execution contract. LMS attribution types do not
  import the LTI runtime or credential store.
- `features/chat/generation-service.ts` owns answer setup, quota reservation and
  refund decisions, generation, persistence handoff and cost outcomes. Its
  `generation-ports.ts` contracts contain application data without RPC, LangGraph
  or runtime types. `integrations/chat-generation.ts` supplies execution, quota,
  cost-ledger and LMS identity adapters. The ledger is opaque to the use case.
  `features/chat/message-service.ts` only adapts requests, HTTP failures and SSE
  events, including opt-in tool progress for older clients. Conversation log
  preparation remains a callback to the existing atomic conversation commit;
  committed turns are never logged twice. Nonstream commit failures and generated
  streaming text retain consumed quota, while failures before generation retain
  the existing refund behavior.
- `features/billing/account-deletion-service.ts` accepts billing lookup and an
  idempotent customer-deletion capability. The integration normalizes Stripe's
  missing-customer error; other errors propagate so the durable outbox can retry
  before account data and billing identity are removed.
- `features/billing/service.ts` accepts a `BillingRepository` and `BillingGateway`.
  `integrations/stripe-gateway.ts` translates provider requests, subscriptions and
  verified events; the service owns plan selection, customer checks, stale-event
  reconciliation and bounded optimistic retries. Event payload projection happens
  after deduplication. Provider calls still finish before the atomic billing write.
- `application/errors.ts` describes failures using application kinds and codes.
  HTTP and tRPC handlers translate them through `shared/errors.ts:asApiError`.
  The extracted chat/billing workflows and Q&A repositories do not construct HTTP
  errors. Existing `ApiError` callers keep their existing response envelopes.
- Application chat/video models are independent of RPC schemas. The normal API
  typecheck compiles `type-tests/application-models.ts` to catch contract drift.
- ESLint restricts the extracted workflows, contracts and pure helpers. The
  architecture test also walks their actual transitive imports, including type
  imports, so a helper cannot silently reintroduce a runtime dependency. The pure
  shared `@videoq/trpc/video-upload` constants/helpers are an explicit exception;
  router and RPC schema imports are rejected.

The teaching connection workflow in `features/teaching/core.ts` accepts ticket,
provider-authority and atomic-commit capabilities. `integrations/teaching.ts`
owns runtime configuration, credential validation and provider clients; the
existing service module preserves caller compatibility. Authority is rechecked
before the repository atomically consumes the ticket and connects the course.
Application ticket types are checked against transport schemas by the normal
typecheck, and the workflow is covered by the transitive dependency checks.

The LMS upload workflow in `features/lms/upload-service.ts` owns generation
snapshot validation, immutable-attempt sequencing, cleanup decisions and processing
handoff. `integrations/lms-upload.ts` supplies streaming storage, deadlines,
maintenance scheduling and persistence. Claims, adoption and confirmation keep
the existing atomic repository operations, including generation and authority
rechecks; storage I/O happens outside those transactions. Application failures
are translated at the compatibility boundary. The workflow is included in the
same transitive import restrictions as the other extracted use cases.

This is incremental separation. Several LMS services still combine orchestration
with runtime adapters. Compatibility entrypoints may accept runtime bindings,
but delegate business decisions to injected services. New business rules
belong in injected services or pure policies; add runtime composition to
`integrations` and extend the boundary checks when extracting another workflow.
Keep authorization facts and writes in the same transaction/batch: extracting a
policy must not move a security check outside its atomic database operation.

Run the focused policy and lifecycle checks with:

```bash
npm run typecheck --workspace=@videoq/api
npm run lint --workspace=@videoq/api
npm exec --workspace @videoq/api -- vitest run test/chat-generation-service.test.ts test/extracted-management-services.test.ts test/chat-send.test.ts test/billing-account-deletion.test.ts test/membership-service.test.ts test/video-service-atomicity.test.ts test/application-services.test.ts test/qa-policy.test.ts test/video-upload-service.test.ts test/architecture-boundaries.test.ts test/error-handler.test.ts test/trpc.test.ts test/persistence/qa.integration.test.ts test/persistence/video-service.d1.integration.test.ts test/videos-multipart.test.ts test/lti-routes.test.ts
```

Set `PERSISTENCE_TEST_DATABASE_URL` to a disposable PostgreSQL database to run the
same Q&A contract against both backends. Without it, PostgreSQL cases are skipped.
Set `QUOTA_TEST_DATABASE_URL` to a disposable PostgreSQL database for the existing
billing webhook, conversation, course-read and share/feedback integration suites.

## API contract

- Endpoint: `/api/trpc`
- Lists: `{ data: T[], meta: { total, limit, offset } }`
- Error data: tRPC code, HTTP status, `applicationCode?`, `details?`
- Dates and times: UTC ISO-8601

Hono's raw routes are limited to Better Auth / OAuth discovery, the Stripe webhook,
MCP, health checks, media binaries, multipart uploads, chat SSE, and CSV exports.

The canonical tRPC router lives in [`packages/trpc`](../../packages/trpc/).
Hono connects existing services to the procedure context. A REST/OpenAPI JSON API
and API reference UI are not provided.

## Authentication

Better Auth (`/api/auth/*`) is the source of truth.

### Browser sessions

- Cookie sessions through Better Auth. The SPA uses `credentials: "include"` + `better-auth/react`
- Email verification, password resets, and email changes use Better Auth verification flows
- Secret: `BETTER_AUTH_SECRET` / public URL: `BETTER_AUTH_URL`
- Google sign-in (optional): `GOOGLE_CLIENT_ID` + `GOOGLE_CLIENT_SECRET`
  Redirect URI: `{BETTER_AUTH_URL}/api/auth/callback/google`

### API keys / OAuth

- API keys: `@better-auth/api-key` (prefix `vq_`; the server sets `permissions` from the selected configuration)
- MCP / third parties: `@better-auth/oauth-provider`
  (unauthenticated DCR is allowed for MCP; registration is rate-limited, and confidential client secrets expire after 30 days)
- Better Auth 1.7's protected resource is fixed at `/api/mcp`. When migrating to 1.7,
  revoke legacy DCR clients and tokens and register again. Access tokens last five minutes;
  both Bearer and DPoP are validated
- tRPC and browser-facing raw routes use cookie sessions; MCP uses API keys / OAuth Bearer tokens
- MCP OAuth validates `videoq.read` / `videoq.write`; the `default` API-key configuration is read-only and `read-write` adds write access
- MCP creation operations use `mcp_idempotency_records` for 30-day idempotency, with per-tool output schemas, safety annotations, and per-user rate limits
- The SPA determines sign-in status with Better Auth's `useSession`; profiles come from `account.me`
- User IDs are Better Auth's standard text UUIDs (existing rows were remapped to UUIDs by `0006_user_id_uuid`, invalidating sessions / OAuth tokens)
  - Schema changes use `drizzle-kit generate` (`meta/0005_snapshot.json` → `0006_snapshot.json`)
  - Data remapping is a historical Drizzle custom migration. It has already been applied; do not regenerate or edit it

## Secret encryption

User-specific external API keys are encrypted with AES-256-GCM.

- Key: `USER_SECRET_ENCRYPTION_KEY` (32 bytes, base64url-encoded)
- Envelope: `v1.<nonce>.<ciphertext+tag>`
- Nonce: 12 bytes generated for each encryption operation

Manage `BETTER_AUTH_SECRET`, any fixed AI provider keys, and S3/SQS credentials through
`wrangler secret` or a local `.dev.vars` file.

## Q&A agent

Q&A uses ReAct with the following core tools, scoped to the current course after access
has been verified. The agent can also use `read_video_window`, `overview_video`, `skim_video`,
`inspect_clip`, and `focus_clip`; see [video navigation and visual evidence](../../docs/guides/visual-evidence.md).

- `get_course_info`: Retrieves the course name, registered description, and total video count, plus each video's ID, title, description, position, and processing state. Up to 20 videos per page and 5 calls per answer. Course descriptions are limited to 2,000 characters and video descriptions to 500, with truncation indicated. Fetch subsequent videos using `videos_meta.next_offset`.
- `search_scenes`: Semantic search over transcripts. Optional `video_ids` narrow the search to specific videos in the course. Omitting them searches the entire course; IDs outside the course or an empty selection are invalid. Up to 3 calls per answer.

Course names, video counts, and similar questions can be answered from metadata
alone, without a vector search connection or embedding API calls. Explanations of
lesson content search transcripts and pair answer segments with source IDs
([structured answers](../../docs/architecture/prompt-engineering.md#structured-answers-citations-and-permissions)). Metadata is also
saved in `retrieved_contexts` as material retrieved for the answer, but is not given
scene citation numbers or timestamps.

Definitions, comparisons, examples, calculations, summaries, and "What can I learn?"
are treated as content questions and instructed to use search. The same applies
to questions consisting only of a term. Course-wide searches can omit `video_ids`
without first calling `get_course_info`. "Show me the registered description" is a
metadata request, while "Summarize the course content" searches transcripts whether
or not a description exists.

A video's `position` is its one-based display position; `order` is its stored sort
value. These are distinct from lecture numbers such as "Lecture 7" in a title.
The model can use tools for up to 19 turns (`MAX_TOOL_ROUNDS`), after which tools are removed and a final
answer is generated. Both streaming and non-streaming paths are supported.

Verification: `test/rag-agent.test.ts`, `test/chat-send.test.ts`, and
`test/workers/rag-agent.test.ts`. To verify pagination, permissions, and video
filtering against real PostgreSQL, set `QUOTA_TEST_DATABASE_URL` and run
`test/rag-course-info.integration.test.ts`.

The optional test below verifies tool selection with a real model. It reads
`OPENAI_API_KEY`, `OPENAI_BASE_URL`, and `LLM_MODEL` from environment variables or
`apps/api/.dev.vars` and incurs LLM API charges. Database and search results use
fixed fixtures. It covers descriptions present/absent, metadata-only, content, and
mixed questions, Japanese/English, and streaming/non-streaming responses. It does
not run in regular CI.

```bash
RAG_SELECTION_LIVE=1 npm run test:unit --workspace @videoq/api -- test/rag-agent-selection.live.test.ts
```

## Database

Drizzle's modern schema is the only runtime model.

Main table groups:

- Auth (Better Auth): `users` (text UUID PK), `session`, `account`, `verification`, `apikey`, `jwks`, `device_code`, `oauth_*`
- Video: `videos`, `video_courses`, `video_course_members`, `video_course_memberships`, `video_course_invitations`, `tags`, `video_tags`, `video_transcription_*`, `video_visual_*`
- Chat: `chat_logs`, `ai_answer_attempts`. `chat_log_evaluations` and `course_evaluation_snapshots` retain data from before evaluation was removed; no new evaluations are performed.
- Vector: `scene_embeddings` (both the worker and Hono use PGVectorStore; Hono searches are scoped to the owner and videos in the course)

Admin procedures: `admin.listUsers`, `admin.patch*`, and `admin.reindexAll`.
They are used by the frontend's `/admin` page.

Create the first administrator by promoting an existing account, using either its
username or email address:

```bash
npm run user:admin -- alice
```

There are two roles: regular user (`role = user`) and administrator (`role = admin`).
Existing administrators can toggle other users' administrator status in `/admin`.
They cannot remove their own administrator privileges or suspend their own account.

`0028_remove_legacy_user_roles` dropped the obsolete `is_staff` / `is_superuser`
columns while preserving existing `role` values. Production has completed this
migration. CD now runs pending database migrations once before deploying the API.
For an older installation that has not applied `0028`, deploy the updated API
before running the full migration because the old API reads those columns.

If the promotion command matches multiple accounts, it exits without changes.
Use `npm run user:admin -- --id <user-id>` to identify a single account.

If you hit sign-in/sign-up rate limits locally, clear the RateLimiter DO state and
restart the API:

```bash
npm run rate-limit:reset
```

```bash
npm run db:generate -- --name describe_the_schema_change
npm run db:check
npm run db:verify
npm run db:migrate
npm run db:studio
```

`src/db/schema/` is the schema's source of truth. Always create DDL migrations with
`drizzle-kit generate` (`db:generate` above). Do not manually edit generated SQL,
snapshots, or the journal. Only operations that Drizzle Kit cannot express as DDL,
such as data backfills, should use a Drizzle-managed custom migration created with
`npm run db:generate:custom -- --name describe_the_data_change`, starting with
`-- drizzle-kit:custom`. Do not put DDL in custom migrations or use `drizzle-kit push`
in shared or production environments. `db:verify` checks one-to-one correspondence
with the journal, exact agreement between generated DDL and snapshot differences,
and the absence of DDL in custom migrations.

Migration `0023` removes existing tables as part of retiring the learning features.
Existing environments deploy that removal in two releases; no maintenance variable is
needed. See the [deployment procedure](../../docs/design/deployment-diagram.md#deploying-the-learning-feature-removal).

## Asynchronous jobs

SQS messages use native JSON:

```json
{
  "type": "transcribe_video",
  "job_id": "uuid",
  "payload": { "video_id": 123 }
}
```

The consumer is [`apps/worker/`](../worker/). Local development uses ElasticMQ;
production uses Amazon SQS.

Job submissions are stored in the `external_tasks` outbox in the same transaction
as business data updates and are usually delivered to SQS immediately. Alarms in
the `TASK_SCHEDULER` Durable Object schedule recovery for rows left after a process
stops just after database commit or after an SQS failure, as well as abandoned
uploads. The five-minute cron is no longer used. Daily maintenance also performs
recovery. Rows that fail 48 times are stopped by setting `dead_at` and reported in
structured logs.

At `17 3 * * *` (UTC), completed outbox and execution ledger records older than
30 days—longer than SQS's maximum retention period—are deleted in small batches.
Execution records still referenced by incomplete outbox entries are retained.

## Cloudflare bindings

The production Worker is deployed from `.github/workflows/cd.yml` using
`wrangler.jsonc`, with `apps/api` as Wrangler's working directory. Unlike Pages,
there is no repository root directory setting in the Cloudflare Dashboard.

| Binding | Purpose |
|---|---|
| `HYPERDRIVE` | Neon PostgreSQL |
| `VIDEO_BUCKET` | Videos, transcripts, and thumbnails |
| `RATE_LIMITER` | Distributed rate limiting |
| `TASK_SCHEDULER` | Scheduled recovery for undelivered jobs, abandoned uploads, etc. (Durable Object) |
| `CHAT_EXECUTION` | Runs each chat answer in its own SQLite-backed Durable Object |

See `wrangler.jsonc` and `.dev.vars.example` for R2's S3-compatible endpoint, SQS,
LLM/embedding settings, the OAuth issuer, and related configuration.
Production authentication and invitation emails require `MAILGUN_API_KEY`.
Cloudflare Email Sending and KV are not used. If email is not configured locally,
promote the account using the README instructions.

Commands to synchronize and inspect production resource settings:

```bash
npm run cf:hyperdrive:disable-cache
npm run cf:hyperdrive:show
npm run cf:r2-cors:apply
npm run cf:r2-cors:list
```

`r2-cors.production.json` is the source of truth for R2 CORS. For updates, use a
token that can manage only Hyperdrive and the target R2 bucket, separate from the
regular Worker deployment token.

## Development

```bash
npm install
npm run dev
npm run typecheck
npm test
npm run cf-typegen
```

To start the local dependencies together:

```bash
docker compose up -d postgres garage garage-init elasticmq worker
```

For separately hosted OpenAI-compatible embeddings, set `EMBEDDING_BASE_URL` and
optionally `EMBEDDING_API_KEY`; unset values reuse `OPENAI_BASE_URL` and the key for
that endpoint (`OPENROUTER_API_KEY` on OpenRouter, otherwise `OPENAI_API_KEY`). Embeddings always use the OpenAI-compatible protocol, including
private llama.cpp/vLLM services. The worker must use the same model and endpoint.
