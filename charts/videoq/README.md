# VideoQ on-prem Helm chart

This chart installs the static web application, production Node.js API, Python
SQS pollers, a migration Job, and recovery/retention CronJobs. It creates no
database, object store, queue, inference server, ingress controller, certificate
issuer, or cluster. Use an existing Kubernetes cluster, or a single-node K3s
installation for an initial deployment. This chart targets Kubernetes 1.29+.
Helm 4.3.1 is used by CI.

To keep chat, embeddings and uploaded-audio transcription on the site too, use
the optional [local inference chart](../videoq-inference/README.md) and this
chart's `examples/local-ai-llamacpp.yaml` or `examples/local-ai-vllm.yaml` overlay. It includes CPU and NVIDIA GPU
provisioning instructions, model caches, acceptance checks and egress controls.
The default application values continue to select hosted OpenRouter inference.

The default Cloudflare Workers/Lambda deployment remains available. The on-prem
API uses Hono directly on Node, PostgreSQL row locks for shared rate limits,
and scheduled DB outbox sweeps in place of Durable Object alarms. Chat executes
through the same authentication, permissions, quota and streaming routes.

## Prepare infrastructure

- PostgreSQL 17 with pgvector, a dedicated database, and a migration-capable DB
  role. Limit network access to the app and your administration/backup tools.
  Use your existing PostgreSQL HA/backup service if available.
- S3-compatible storage (for example, an operator-managed Garage deployment),
  a pre-created private bucket, and bucket credentials. `storage.endpoint` must
  be reachable by browsers; `storage.internalEndpoint` is used for server-side
  operations. The worker uses that internal endpoint when configured, otherwise
  the public one. Configure bucket CORS for the exact `publicUrl`, allowing
  GET/HEAD/PUT and exposing ETag for multipart uploads. Retain support for Range,
  conditional reads, multipart uploads, listing and deletion. See
  [the local Garage setup](../../infra/garage/README.md) for the app's S3 contract;
  its single-node development credentials and durability settings are examples
  for local development only.
- A persistent SQS-compatible queue, with a dead-letter queue and a redrive
  policy (the local setup uses five receives). Queue visibility must be at least
  900 seconds. API and worker must be able to reach the configured queue URL.
  The stock development ElasticMQ configuration does not configure persistence;
  provision and verify persistence/restart recovery before production use.
- An ingress controller, DNS and TLS. Route `/api`, `/.well-known`, `/health`
  and `/ready` to API port 8787, and the remaining paths to web port 80. The
  optional Ingress does this routing, preserving paths without rewriting.
- OpenRouter access or separately deployed compatible inference services. For a
  closed network, configure all three: chat, embeddings and Whisper.
  The on-prem edition disables Google sign-in, YouTube/SearchAPI, Mailgun and
  Stripe. Chat models must support the existing tool/JSON contract and,
  when visual Q&A is enabled, image input. Validate these before rollout.

Set the ingress response timeout to at least the application's answer budget
and disable response buffering for SSE. On-prem requests default to using their
TCP peer for IP rate limits. Set `api.trustedProxyHops` to the exact number of
trusted HTTP proxies only after those proxies sanitize/append forwarding headers.
Restrict access to the API Service to those proxies when trusting headers. Client
supplied `CF-Connecting-IP` and `X-VideoQ-Client-IP` are ignored by the Node entry.

For signed internet-connected distribution and verified updates, see
[the release guide](../../docs/guides/on-premises-releases.md). The signing workflow
requires a first successful run on main before its published artifacts exist.

## Build and load images

From the repository root, build for the architecture of the target nodes:

```sh
docker build -f apps/api/Dockerfile -t registry.example.edu/videoq/api:0.1.0 .
docker build -f apps/web/Dockerfile -t registry.example.edu/videoq/web:0.1.0 .
docker build -f apps/worker/Dockerfile.onprem -t registry.example.edu/videoq/worker:0.1.0 apps/worker
docker push registry.example.edu/videoq/api:0.1.0
docker push registry.example.edu/videoq/web:0.1.0
docker push registry.example.edu/videoq/worker:0.1.0
```

The API image contains production dependencies and bundled API/migration entries;
it runs as UID 1000, without Wrangler. The worker runs as UID 10001 and installs
hash-verified dependencies from `uv.lock`. Web uses the existing nginx image on
port 80; clusters enforcing non-root containers for every workload need an
approved non-root web image serving the same port. The web image builds with
`VITE_API_URL=/api` and S3 uploads enabled, so the same image can serve different
site hostnames. Operator information and upload size advertised by the frontend
are build-time arguments in `apps/web/Dockerfile`; align them with your site.

For a disconnected site, build ahead of time, mirror **all three** images into
the site's registry, and transfer the chart with `helm package charts/videoq`.
The chart has no downloadable subchart dependencies.

## Configure credentials

Create the namespace and a Secret **before** installation. Store a file outside
the repository with restrictive permissions and these keys:

```dotenv
DATABASE_URL=postgresql://videoq:REPLACE@postgres.database.svc.cluster.local:5432/videoq
BETTER_AUTH_SECRET=REPLACE_WITH_AT_LEAST_32_RANDOM_CHARACTERS
USER_SECRET_ENCRYPTION_KEY=REPLACE_WITH_32_RANDOM_BYTES_AS_BASE64URL
R2_ACCESS_KEY_ID=REPLACE
R2_SECRET_ACCESS_KEY=REPLACE
AWS_ACCESS_KEY_ID=REPLACE_WITH_QUEUE_KEY
AWS_SECRET_ACCESS_KEY=REPLACE_WITH_QUEUE_SECRET
OPENROUTER_API_KEY=REPLACE_WITH_OPENROUTER_KEY
```

Generate independent secrets with `openssl rand -base64 48` and
`openssl rand -base64 32 | tr '+/' '-_' | tr -d '='` respectively. The encryption
key must be identical for API and worker, and retained to decrypt existing user
secrets. S3 credentials and queue credentials are separate pairs. Optional Secret
keys include `MAILGUN_API_KEY`, `MAILGUN_SENDER_DOMAIN`, `GOOGLE_CLIENT_ID`,
`GOOGLE_CLIENT_SECRET`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, and
`AWS_SESSION_TOKEN`.

Hosted chat prefers `ai.federationPolicyId` with an AWS identity; `OPENROUTER_API_KEY` is an explicit development fallback. Local chat requires a nonempty `LLM_API_KEY` or `OPENAI_API_KEY` even for an OpenAI-compatible local
server without authentication; use a local placeholder such as `local-inference`
in that case. Embeddings reuse it unless `EMBEDDING_API_KEY` is set.

```sh
kubectl create namespace videoq
kubectl -n videoq create secret generic videoq-runtime --from-env-file=/secure/path/videoq-runtime.env
```

An existing secret manager can create this Secret instead. Chart values contain
non-secret settings only. The migration hook reads `DATABASE_URL` directly from
the pre-existing Secret and does not depend on a release ConfigMap. Configure
`imagePullSecrets` when your registry requires authentication.

## Install and verify

Copy `examples/site.yaml` to a site-specific file outside the repository and
replace its hosts, internal addresses, repositories, TLS Secret and ingress class.
The example requires digests: replace all three zero digests with the respective
digests recorded when pushing your reviewed builds.
The example `registry.example.edu` images are names for your own builds, not
published images supplied by this repository.

```sh
helm lint charts/videoq --strict -f /secure/path/site.yaml
helm template videoq charts/videoq -n videoq -f /secure/path/site.yaml
helm upgrade --install videoq charts/videoq -n videoq -f /secure/path/site.yaml --wait --timeout 15m
helm test videoq -n videoq --timeout 2m
kubectl -n videoq get deployments,pods,jobs,cronjobs
curl --fail https://videoq.example.edu/ready
```

With the example release/name defaults, resource names start with `videoq-videoq`.
Inspect `kubectl -n videoq logs deployment/videoq-videoq-api` and
`kubectl -n videoq logs deployment/videoq-videoq-worker`. The migration must
succeed before Helm creates/updates application workloads. After installation,
create the first administrator with the production API image (public signup is disabled):

```sh
kubectl -n videoq exec deployment/videoq-videoq-api -- node dist/provision-user.mjs \
  --admin --username site_admin --email you@example.edu
```

Upload a short video, wait for transcription/indexing, ask a question and verify
that its cited timestamp plays correctly. Verify existing-object reads, multipart
uploads and source deletion with the chosen S3 implementation. These checks use
your configured inference services and may incur costs.

## Local inference and scaling

Layer `examples/local-ai-llamacpp.yaml` (CPU) or `examples/local-ai-vllm.yaml` (GPU) over your site file after replacing the model and
endpoints. Both runtimes receive the same embedding provider/model. Dimensions
remain fixed at 1536; changing models for existing data requires a planned full
reindex, even if dimensions match. See [embedding guidance](../../docs/guides/embeddings.md).

Scale API and worker independently using `api.replicas` and `worker.replicas`.
Account for API replicas × (`api.databasePoolMax` + `api.rateLimitPoolMax`), plus worker connections,
maintenance and vector-search connections in your PostgreSQL capacity. There is
no automatic node or queue-based autoscaling in this initial chart. GPU inference
services are separate workloads with their own device plugins and GPU allocation;
CPU video-processing workers call their configured endpoints.

Recovery runs every minute by default and reads the persisted DB outbox; restarts
do not lose schedules. Retention runs daily at 03:17 UTC. CronJobs forbid overlap
within each job type and also acquire PostgreSQL advisory locks across releases.
PostgreSQL rate-limit rows expire and are pruned by these jobs. Monitor failed
Jobs, dead letters, queue age and database/storage backups.

The poller defaults to one message at a time and an 840-second execution deadline,
below its 900-second DB lease and queue visibility. Timed-out work is not
acknowledged and resumes via the existing retry/checkpoint mechanism. SIGTERM
stops polling and lets the active job complete; the chart gives it 960 seconds.
The API drains active connections/background work with a 55-second shutdown
deadline and a 65-second pod termination grace period.

## Upgrades, rollback and data

Record the registry digest of each reviewed image and enable
`requireImageDigests: true` for production. Set `api.image.digest`,
`web.image.digest` and `worker.image.digest` to their respective
`sha256:<64 lowercase hex characters>` values. A digest takes precedence over
the display tag. API Deployment, migration Job, both CronJobs and the Helm test
all use the same API digest. With this option enabled, rendering fails if any
component lacks a digest. Pin the digest in the site's deployment repository;
changing the contents behind a tag will not change the deployed code.

Back up DB, object data and the
encryption key before upgrades. Test migrations and the new images against a
restored copy first. The pre-upgrade Job applies migrations before replacing
workloads, so migrations must support the old running application too. For a
breaking schema/data change, follow a separate expand/backfill/contract release
procedure with the required writer drain; this chart does not automate that.

The historical structured-answer cutover refuses to run with old columns unless
writers are explicitly stopped. Complete that one-time migration manually using
the repository's migration procedure before installing this chart onto such an
old database. Do not force the safety flag in a live Helm upgrade.

`helm rollback` restores application resource configuration. It does not undo SQL
migrations, restore objects or recover the encryption key. Roll back images only
when the old release supports the current schema. Otherwise use the tested DB
restore/recovery procedure. Disable `migration.enabled` only if migrations are
being run and gated by another deployment system.

Changing a Secret does not change the Pod template. After rotating it, restart
API and worker deployments; new CronJob pods read the updated values. Helm
uninstall removes application resources while operator-owned DB, objects and
the pre-existing Secret remain outside the release lifecycle.

## Development validation

```sh
npm run build:node --workspace @videoq/api
HELM_BIN=/path/to/helm npm run test:unit --workspace @videoq/api -- test/helm-chart.test.ts
```

The reusable On-prem Validation workflow is called by CI and contributes to
the existing required `CI Success` check. A selected on-prem check that fails,
is cancelled or is unexpectedly skipped prevents that gate from succeeding.
It builds all three images and runs the production
API image over HTTP against a disposable PostgreSQL database, including auth,
chat access checks, shared rate limiting, maintenance and graceful shutdown.
It scans every final image with pinned Trivy, blocks HIGH/CRITICAL findings
including unfixed ones, and retains CycloneDX package inventories for 30 days.
Image builds and scans receive no production credentials or write token.

For Docker Desktop validation, use a disposable host DB and set
`ONPREM_SMOKE_DOCKER_NETWORK=bridge` plus
`ONPREM_SMOKE_CONTAINER_DATABASE_URL` to the same database through
`host.docker.internal`. `ONPREM_SMOKE_DATABASE_URL` remains the host-side URL.
Linux CI uses host networking by default.

## Security updates and automation boundary

Dependabot proposes dependency updates. Eligible PRs enter the Merge Queue after
the repository's required checks. A successful merge deploys the existing
Cloudflare/Lambda service, and the separate On-prem Release workflow publishes
signed images and charts. This chart does **not** connect to a site's cluster, update its image digests, or apply Helm upgrades.
An operator-managed delivery system must build and scan an image, verify its
provenance, propose the new digest in the site configuration, and gate rollout
on migration/health checks. Preserve approval for breaking migrations.

SBOM inventories support investigation; admission-time signature verification, running Kubernetes image rescans, host/Kubernetes
patching and site backup recovery need their own operational configuration.
The existing daily container monitor covers production Lambda, not site clusters.
Image scan results are specific to each build. Inspect the current CI and signed
release evidence described in the [release guide](../../docs/guides/on-premises-releases.md).
A passing functional test does not replace vulnerability or signature verification.

The local inference chart provides Linux amd64/arm64 llama.cpp CPU and
vLLM NVIDIA CUDA/AMD ROCm recipes, with independent role selection.
Use the matching `examples/local-ai-llamacpp.yaml` or `examples/local-ai-vllm.yaml`.
`ai.embeddingBaseUrl` maps to `EMBEDDING_BASE_URL` independently of the chat
endpoint. These services use the OpenAI-compatible protocol. Optional
`EMBEDDING_API_KEY` belongs in the runtime Secret;
when absent it reuses `OPENAI_API_KEY`. Keep the API and worker embedding settings
identical and reindex scenes when changing the embedding model or processing.

Existing compatible speech services can use `ai.whisperLocalUrl` and
`ai.whisperLocalModel` with `ai.whisperBackend: local`. An optional
`WHISPER_LOCAL_API_KEY` belongs in the runtime Secret and overrides the shared
`OPENAI_API_KEY` for speech only. The built-in VideoQ gateway's model alias
remains `whisper-local`. The service must return real segment timestamps in
`verbose_json`; text-only transcription is insufficient.

## On-prem application edition

The web Docker build defaults to `VITE_DEPLOYMENT_EDITION=onprem`; the Node API
and application Helm ConfigMap select `DEPLOYMENT_EDITION=onprem`. The two must
match. Cloud web builds keep the default cloud edition and existing behavior.
The edition is operator configuration, not a browser preference.

On-prem builds exclude the LP, pricing, SaaS legal/refund pages, public signup,
email-verification/forgot-password pages, demo media, sitemap and remote Google
Fonts. `/` leads signed-out users to login and signed-in users to their dashboard.
Billing and upgrade controls, Google sign-in, YouTube import/player/thumbnail
requests and SearchAPI settings are removed. The API rejects their operations
with `FEATURE_DISABLED`, even if old provider credentials remain in the Secret.
Do not add Stripe, Google, SearchAPI or Mailgun credentials to the on-prem Secret.
Mail-dependent self-service email changes and public password recovery are disabled.

The bootstrap command prints an account setup URL. Send it privately to the
administrator; it expires after 15 minutes and is single-use. It uses the native
Better Auth password reset flow and sends no email. The admin page can add users
and issue password recovery links. New UI-created users always start with the
ordinary user role. To recover access as a local operator:

```sh
kubectl -n videoq exec deployment/videoq-videoq-api -- \
  node dist/provision-user.mjs --reset USER_ID
```

Course owners can issue/reissue course invitation links and share them privately.
Recipients first need an account issued by the administrator. Course invitations
keep the existing seven-day validity and email-identity check; reissuing revokes
the previous link. Neither invitation hashes nor user setup tokens are emailed
or sent to third-party services.

New on-prem accounts have no SaaS free-tier storage, monthly upload, processing
or AI-answer caps. Administrators can set operational limits in the admin page,
or set `DEFAULT_STORAGE_LIMIT_GB`, `DEFAULT_MONTHLY_UPLOAD_LIMIT_GB`,
`DEFAULT_PROCESSING_LIMIT_MINUTES` and `DEFAULT_AI_ANSWERS_LIMIT` for future users.
`unlimited` means no cap. Per-file transport limits and rate limits still apply.
Existing user limits are preserved; review migrated users in the admin page.

Core video/course management, uploaded-media transcription, search, cited chat,
usage reporting, local API keys/MCP and intranet sharing remain available.
AI endpoints are configured separately: apply the chosen local-inference overlay
for fully on-site processing. The application edition does not change a
site-selected inference endpoint or migrate existing embeddings.

The hosted defaults route answers/images, embeddings, and transcription through
OpenRouter. Prefer `ai.federationPolicyId` with `ai.federationAudience` and AWS workload credentials. An explicit development alternative is `OPENROUTER_API_KEY` in the existing runtime Secret. The models
are `openai/gpt-6-luna`, `openai/text-embedding-3-small` (1536 dimensions), and
`openai/whisper-large-v3-turbo`. Remove stale `LLM_*` / `EMBEDDING_*` endpoint/key
overrides to share the provider. Local overlays continue to use private inference.
