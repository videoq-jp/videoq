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

See [the domain model and context map](../../docs/architecture/domain-model.md) for business terms, aggregate invariants and dependency ownership.

For API-first development without a database or provider, see [the local prototype and use-case scaffolding guide](../../docs/architecture/video-clean-architecture-adoption.md). Run `npm run dev:prototype` from the repository root.

## Learning integration authentication

Classroom uses Better Auth's Google provider configuration, OAuth request
builders and token parser for authorization-code exchange and refresh, and its
authorization URL builder for PKCE and nonce parameters. The transport adapter
aborts token requests after ten seconds and JWKS requests after five seconds,
including response-body reads, and refuses HTTP redirects. Better Auth's JWKS
cache shares concurrent loads, expires after five minutes and refetches rotated
keys with a cooldown. Classroom and LTI launch identities both pass through the
exported `verifyProviderIdToken` API from `better-auth/oauth2`; the application
decodes claims only after successful verification. Google supplies the issuer,
audience and algorithms through its provider configuration; Classroom supplies
the cached key resolver for Google's fixed JWKS endpoint. LTI
uses the administrator-approved issuer, client and JWKS endpoint. JWT headers
cannot select a new issuer or key URL. `lib/learning-oidc.ts` retains the existing
strict launch time windows on top of Better Auth's default clock tolerance.

This is reuse of Better Auth's OAuth/OIDC components, not conversion of every
learner into a Better Auth user or session. LTI's `id_token` / `form_post` launch
and Classroom's popup/iframe flow keep their browser-bound, single-use state
and scoped learning credentials. Teacher/student authority, deployment,
resource, account-hint and live Classroom membership checks remain application
responsibilities. Existing encrypted Classroom credentials and LTI signing-key
rings retain their format; no database migration or new OAuth callback URL is
required. LTI client assertions still use `jose` because they carry an
LTI-specific deployment claim. Neither using Better Auth nor issuing an Ed25519
VideoQ JWT changes Google's or the LMS's RSA signatures into post-quantum
signatures.

Regression coverage includes real signed tokens, forged signatures, missing
claims, wrong issuer/audience/nonce, stricter time limits, PKCE, browser state
replay, encrypted refresh and disconnect. Provider-specific browser acceptance
must still be checked against a real Classroom/LMS installation before release.

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
├── domain/                # Business policies owned by bounded context
├── application/           # Use-case models, failures and proof types
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

- `features/admin/core.ts` owns self-lockout prevention, deletion dispatch and
  reindex handoff. `integrations/admin.ts` captures runtime bindings and request
  credentials; the use case accepts application commands without HTTP or RPC
  types. The existing repository still checks live administrator authority and
  commits account changes atomically. Deletion dispatch runs only after the
  durable task has been committed, and failures propagate for retry.
- `features/lms/native-learning-service.ts` builds a server-derived learning grant,
  rechecks current course authority, limits learning scope and consumes the
  request through an injected atomic session capability. `native-auth.ts` verifies
  JWT signatures, endpoint/body binding and claim lifetimes before invoking it;
  `integrations/native-learning.ts` supplies authority, hashing and persistence.
  `domain/lms/native-learning.ts` owns grant/session models. Normal typechecking
  checks their compatibility with the transport schemas. Management-only videos
  never enter the learning scope, and a session rejection cannot return a grant.
- `domain/qa/policy.ts` owns the shared access and mutation rules. PostgreSQL
  evaluates these rules on transaction-scoped facts; D1 composes them into SQL
  predicates inside its atomic batch. Session validity, membership, current video
  scope, locking and audit writes remain in the persistence implementations.
  Displayed edit/delete capabilities use the same policy as mutations.
  The same pure policy selects moderation audit conditions and parent-question
  timestamp effects; adapters evaluate them on locked facts or SQL predicates.
  Native capabilities and the requirement to see both a question's original source
  and its current video binding also belong to this policy. D1 consumes the policy's
  audit actions as well as its predicates. Repository operation methods preserve a
  single atomic capability; statement construction, IDs, vote-table mapping and
  result formatting remain external.
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
  `domain/learning/membership-policy.ts` owns tag-link reuse, native/LMS membership
  eligibility, first-occurrence deduplication and complete-permutation checks.
  PostgreSQL applies those rules to locked rows; D1 compiles the same predicates
  inside its atomic batch. SQL keeps append positions, generated IDs and actual
  mutation counts consistent under concurrency.
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
- `features/evidence/scene-search-service.ts` owns search scope validation,
  invocation budgets, progress and safe result projection. `course-info-service.ts`
  owns bounded course metadata projection and paging. Tool adapters retain Zod/MCP
  schemas and inject search, cancellation and already-authorized course capabilities.
  Counts reserve before awaiting providers so concurrent calls share one budget.
  `video-evidence-service.ts` owns the shared call/image reservations, duplicate
  suppression, subtitle windows/timelines and serialized visual execution. Storage,
  model SDKs, usage recording and AbortSignal are supplied through tool adapters;
  the application also checks cancellation before loading private metadata.
  `application/video-evidence.ts` owns sparse/dense frame selection, image limits
  and focus-interval validation; dense samples use a half-open interval and must
  fit the remaining budget without resampling. `application/evidence.ts` owns
  scene-hit data. The old `lib/video-evidence` path retains compatibility exports
  and physical cache keys/byte limits; inner workflows cannot import that facade.
- `features/chat/citation-policy.ts` validates citation identities and safe syntax
  boundaries with domain models. `answer-text-service.ts` owns monotonic streamed
  text and Unicode/JSON escape boundaries through an injected decoder;
  `answer-content-service.ts` checks provisional text/citations against the final
  answer. SDK partial-JSON parsing, Zod decoding, count-only logging and provider
  error formatting remain in the `lib` adapters.
- `domain/billing/quota-policy.ts` owns quota capacity comparisons, reservation
  amount validation, result types and account/storage/monthly failure precedence.
  Persistence implements the comparison algebra with bound SQL expressions so
  admission still executes inside conditional writes and atomic batches. Database
  clocks, refund period fences, locks and representation limits stay in adapters.
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
- `features/chat/evidence-registry.ts` owns restored citation identities, source
  deduplication and allowed-video projection; LangChain state/callbacks remain in
  `lib/rag.ts`. `features/billing/cost-ledger.ts` owns numeric-only usage and call
  lifecycle through injected clock/identity capabilities. Its runtime compatibility
  adapter still supplies UUID/time and persists anonymous attempt outcomes.
- `features/account/service.ts` owns search-credential status/save/removal.
  `integrations/account-credentials.ts` supplies encryption, actor resolution and
  persistence. Save completes encryption before resolving the actor and writing;
  only ciphertext or null reaches the repository. RPC handlers format errors.
- `features/lti/operation-policy.ts` owns delegated conversation, report, tag,
  material and Q&A capability/scope selection. Readable and manageable materials
  are intersected with current course membership; conversation exports omit log IDs
  and feedback credentials. Schema parsing and protocol responses remain routes.
  `features/course-reports/service.ts` validates and aggregates report data.
  `features/material-management/service.ts` attempts dispatch after a committed
  operation and retains acceptance when immediate dispatch must be deferred.
- `domain/lms/resource-reconciliation.ts` owns LMS resource revision conflicts,
  course/media binding coherence, idempotent replay, reuse/replacement, language
  locks and membership/vocabulary change decisions. PostgreSQL evaluates it on
  transaction-scoped snapshots; D1 fences the same snapshots in its mutation
  batch before applying the plan. `domain/lms/lms-resource.ts` owns resource data;
  persistence contracts preserve their existing type exports.
- `application/resource-mutation.ts` owns shared-material deletion refusal,
  unfinished-upload refund and late-cleanup eligibility, content identity retention,
  course-title precedence and upload error classification. SQL adapters execute
  refunds with the original period fence and compile error choices inside the
  atomic write. Durable cleanup delivery, physical transfer grace periods and
  provider-specific payload serialization remain external.
- `application/lms-owner.ts` owns active/non-deactivated owner admission, inclusive
  ban expiry and material-teacher connection coherence. PostgreSQL and D1 compile
  the same policy into their guarded queries and atomic writes. Adapters retain
  their original database clocks, fixed aliases, lock order and snapshot fences;
  teacher ownership is derived from the connection independently of the installer.
- `features/lti/learning-service.ts` owns material projection and scoped question
  preparation for the shared LTI/native/Classroom routes. It removes old answers
  after recorded scope shrinkage, checks saved-conversation and playback access,
  and adds transcript-cue context through injected course/transcript capabilities.
  The same service resolves current course access, enforces transcript permissions,
  strips owner log IDs from history, binds feedback to the originating session and
  records history before issuing feedback credentials. Feedback authority and course
  checks still precede throttle consumption and writes. HTTP parsing, throttle
  adapters, credential codecs, SSE framing and failure responses stay in the route.
- `features/maintenance/scene-index-service.ts` owns leased vector synchronization,
  readiness retries, immutable-ID compensation and missing-vector repair selection.
  Its gateways hide Vectorize and LangChain; provider batching and document metadata
  projection remain in persistence adapters. All started parallel work is awaited,
  including after a database claim fails. Repair progress is recorded only after
  every provider read succeeds; guarded outbox insertion remains SQL.
- `features/maintenance/visual-object-service.ts` owns cleanup identity/key validation,
  bounded processing and retry decisions through `VisualObjectCleanupRepository`.
  `features/worker-internal/reindex-service.ts` checks page/index configuration through
  injected capabilities and skips provider setup for empty pages.
- `application/onprem-accounts.ts` owns account normalization, role selection and
  activation/reset orchestration. `integrations/onprem-accounts.ts` supplies
  transaction-scoped Better Auth capabilities; account creation and reset-token
  issuance stay in the same PostgreSQL transaction. A missing activation link
  aborts that transaction. Random credentials remain private to the adapter.
- `features/worker-internal/transcription-service.ts` owns run/source consistency
  and duplicate-completion decisions. The persistence factory only supplies ports;
  the repository still commits run completion, subtitles and the outbox atomically.
- `domain/lms/resource-access.ts` owns account-ban expiry, scope-claim parsing
  and read/write authorization for verified OAuth credentials. `domain/identity/admin.ts`
  owns supported-role and administrator self-demotion rules. Better Auth adapters
  retain JWT/DPoP validation, fresh account lookup, native permission checks and
  error/challenge formatting. Policy failures preserve the existing HTTP response.
- `features/classroom/workflow-service.ts` owns catalog filtering, authorized material
  selection, teacher connection, learning-session creation/revalidation and playback
  selection. `integrations/classroom-workflow.ts` supplies Google clients, encryption,
  storage and media URLs. Previously granted chat scope is retained when a session
  is revalidated, so shared-chat authorization can detect removed materials.
- `features/maintenance/audit-retention-service.ts` owns the enabled retention sweep,
  time/pass limits and backlog reporting. Runtime configuration, clock and repository
  creation are supplied by `features/lti/audit-retention.ts`; atomic deletion batches
  remain in the persistence adapters.
- `features/maintenance/policy.ts` owns retention defaults and batch bounds shared
  by completed delivery history and MCP idempotency records.
  `idempotency-retention-service.ts` validates before acquiring its repository;
  the compatibility entrypoint supplies runtime composition. PostgreSQL and D1
  delivery adapters delegate to the same policy and keep their existing deletion
  SQL, including protection for executions with pending delivery.
- `domain/identity/username.ts` owns username normalization and collision candidates.
  Better Auth profile/user hooks supply the existing uniqueness lookup and UUID
  generator. Fifty attempted candidates, suffix truncation, fallback format and
  failure propagation are preserved; `lib/auth.ts` keeps the public normalization
  export for compatibility.
  `domain/identity/account-registration.ts` applies creation-time quota, usage and
  display-identity defaults; runtime configuration is resolved before invoking it.
  Client/provider fields cannot override the existing fresh-account usage defaults.
- `domain/identity/oauth-consent.ts` owns current-consent scope checks and renewal
  decisions over credential-free grant metadata. `lib/auth-security.ts` retains
  credential decoding, provider rotation, endpoint hooks and OAuth error mapping.
  Missing or already consumed credentials still defer to the native provider;
  narrowed scopes are checked against current consent without caching it.
- `application/agent-execution.ts` owns per-answer tool-round budgets and capability
  selection from an already-authorized course/video scope. `lib/rag.ts` retains
  LangGraph-specific step accounting and middleware composition. Visible-text
  acceptance is in `domain/conversation/answer-generation.ts`; SDK schema decoding and
  provider error translation stay in `lib/structured-answer.ts`.
- `domain/conversation/answer-tool-policy.ts` owns the explicit tool capabilities available
  to answer generation. The MCP/LangChain adapter consumes it directly. Tool
  annotations remain descriptive and do not grant answer capabilities.
- `domain/operations/reindex-job.ts` owns the durable all-video reindex enqueue order:
  generate identity, persist the job, then attempt dispatch. `lib/jobs.ts` supplies
  UUID, outbox and delivery implementations; deferred delivery retains the saved ID.
- `application/conversation-scope.ts` owns user/course/share/visitor and LTI scope
  validation plus canonical thread-identity input. `shared/conversation-scope.ts`
  retains SHA-256 encoding and API error adaptation. Existing thread hashes and
  namespace field ordering are checked against pre-extraction values.
- Application chat/video models are independent of RPC schemas. The normal API
  typecheck compiles `type-tests/application-models.ts` to catch contract drift.
- ESLint restricts the extracted workflows, contracts and pure helpers. The
  DOM-free application TypeScript configuration compiles all extracted workflows,
  contracts and models. The architecture test checks that every ESLint-protected
  module is included in that compilation graph. Opaque upload bodies and generic
  cancellation states keep Web streams and AbortSignal in runtime adapters.
  Synthetic forbidden-import checks cover every protected module, rather than a
  representative file list. The architecture test also walks actual transitive imports, including type
  imports, so a helper cannot silently reintroduce a runtime dependency. Shared upload, tag and invitation policies live in the framework-independent
  `@videoq/domain` package. Share-link normalization/reserved names and transcript-quality
  advisories also live there; course and evidence use cases import those policies
  directly. The old `lib/share-slug` and `lib/transcript-quality` paths are
  compatibility re-exports and are forbidden imports in protected workflows.
  Router and RPC schema imports are rejected.

The teaching connection workflow in `features/teaching/core.ts` accepts ticket,
provider-authority and atomic-commit capabilities. `integrations/teaching.ts`
owns runtime configuration, credential validation and provider clients; the
existing service module preserves caller compatibility. Authority is rechecked
before the repository atomically consumes the ticket and connects the course.
`application/teaching.ts` owns existing-connection conflict checks, provider
installation/resource-link requirements and explicit-versus-existing course
selection. Both persistence implementations evaluate those rules at their original
locked or snapshot-fenced steps. Ticket decoding, exact payload comparison,
database expiry/ownership guards and atomic ticket consumption remain external.
Application ticket types are checked against transport schemas by the normal
typecheck, and the workflow is covered by the transitive dependency checks.

The LMS resource workflow in `features/lms/resource-service.ts` owns YouTube
ingestion eligibility, external identity validation order, manifest digest
sequencing, resource status precedence and upload eligibility. The repository
compatibility entrypoint supplies feature configuration, identity parsing, hashing
and persistence. HTTP routes retain signed URL generation and response encoding;
materials synchronization shares the same status policy. Disabled sources retain
priority over sync errors, course completion and video processing status.
The HTTP synchronization workflow also schedules immediate recovery after commit
and delayed abandonment recovery for file sources. Course sources do not schedule
either operation; a failed commit or immediate schedule cannot advance the workflow.

`features/lms/native-teacher-service.ts` owns teacher bootstrap: require a database
installation and fresh content-management authority, consume a registration-bound
nonce, then issue the teaching ticket. Assertion verification and provider clients
remain outer. The expiry grace and existing ticket fields are preserved.
`features/media/learning-playback-service.ts` shares current-scope membership,
owner-bound metadata lookup and YouTube/file selection between native LMS and
Classroom. Storage signing stays injected; transports retain their error envelopes.
`features/lms/installation-service.ts` owns installation creation, authentication
and token rotation sequencing. The compatibility repository module retains schema
decoding and crypto/runtime composition. Invalid tokens do not open persistence;
service registrations create no sync-token secret, and generated tokens are
returned only after the insert or owner-bound rotation succeeds.
Snapshot duplicate/context/count rules live in
`features/lms/materials-snapshot-policy.ts`; source-kind, deletion and language
coherence live in `domain/lms/lms-resource.ts`. Connector Zod schemas delegate
those decisions while retaining field decoding, schema errors and canonical JSON
field order. File and YouTube sources share the existing 1000-material limit,
with one additional course entry.

`features/evidence/external-service.ts` owns external MCP evidence execution:
current course access, weighted paid-work limits, owner quota reservation, provider
completion-based consumption, refund and final ledger outcomes. Runtime evidence
sessions, cancellation/deadlines, provider calls and ledger persistence are composed
in `integrations/external-evidence.ts`. Cleanup cancellation does not change a
failed execution into an interrupted one. Existing close/refund/ledger ordering
and best-effort accounting failure handling are preserved.

Saved-conversation question eligibility lives in `@videoq/domain/chat` and is
shared by raw HTTP and tRPC schemas. The inner chat generation service also checks
it before course lookup or quota reservation, so caller-supplied history cannot
enter a saved conversation through a different adapter.

The LMS upload workflow in `features/lms/upload-service.ts` owns generation
snapshot validation, immutable-attempt sequencing, cleanup decisions and processing
handoff. `integrations/lms-upload.ts` supplies streaming storage, deadlines,
maintenance scheduling and persistence. Claims, adoption and confirmation keep
the existing atomic repository operations, including generation and authority
rechecks; storage I/O happens outside those transactions. Application failures
are translated at the compatibility boundary. The workflow is included in the
same transitive import restrictions as the other extracted use cases.
Generation and source availability checks before content-header validation also
live in this use case; the HTTP adapter preserves the existing validation order.

The Moodle pairing workflow in `features/lms/pairing-service.ts` accepts an atomic
pairing repository, clock, secret/hash, code encoding, maintenance and settings
capabilities. `integrations/moodle-pairing.ts` supplies runtime implementations;
`features/lms/providers/moodle/pairing.ts` retains input validation and the existing
connector error format. Application pairing data lives in
`domain/lms/moodle-pairing.ts`, independent of Zod and connector schemas. Code
consumption and installation provisioning remain one repository operation;
maintenance and upload settings run only after it succeeds. Boundary checks cover
the workflow and repository contract. `test/moodle-pairing-service.test.ts` covers
issuance, proof rejection, expiry, exchange ordering and failure propagation.

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
npm exec --workspace @videoq/api -- vitest run test/admin-core.test.ts test/native-learning-service.test.ts test/moodle-native-api.test.ts test/persistence/admin-flags.integration.test.ts test/chat-generation-service.test.ts test/extracted-management-services.test.ts test/chat-send.test.ts test/billing-account-deletion.test.ts test/membership-service.test.ts test/video-service-atomicity.test.ts test/application-services.test.ts test/qa-policy.test.ts test/video-upload-service.test.ts test/architecture-boundaries.test.ts test/error-handler.test.ts test/trpc.test.ts test/persistence/qa.integration.test.ts test/persistence/video-service.d1.integration.test.ts test/videos-multipart.test.ts test/lti-routes.test.ts
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
that endpoint (`OPENAI_API_KEY`). Embeddings always use the OpenAI-compatible protocol, including
private llama.cpp/vLLM services. The worker must use the same model and endpoint.

Workers AI Gemma による回答・要約・画像認識の共通設定・検証・切り戻しは [運用手順](../../docs/operations/workers-ai-answers.md) を参照してください。
