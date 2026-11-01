# Deploy VideoQ

## Production architecture

- Frontend: Cloudflare Worker + Static Assets `videoq-web` (`apps/web`, public URL: `https://videoq.jp`)
- Docs: Cloudflare Workers Static Assets `videoq-docs` (public URL: `https://docs.videoq.jp`, Japanese: `/ja/`)
- Web API: Cloudflare Workers `videoq-api` (`apps/api`, Hono)
- DB: Neon PostgreSQL + Hyperdrive
- Object storage: Cloudflare R2
- Async queue: Amazon SQS
- Async compute: Python worker on AWS Lambda

## 1. Database and R2

1. Create a Neon project and pooler connection.
2. Connect Cloudflare Hyperdrive to Neon with **query caching disabled**. Caching
   can make reads after writes stale, including authentication, permissions, and billing.
3. Create an R2 bucket and an S3 API token restricted to Object Read & Write on `videoq-media-prod`.
4. Set the production binding IDs and bucket in `apps/api/wrangler.jsonc`.

Sync the existing production Hyperdrive configuration and R2 CORS by running the
manual [`cloudflare-resources.yml`](../.github/workflows/cloudflare-resources.yml)
workflow after approval for the `production-infra` environment. Verified Dependabot
Terraform provider minor/patch updates use a separate automatic apply job when
`TERRAFORM_DEPENDENCY_AUTOAPPLY_ENABLED=true`; resource changes, major updates,
and manual runs still require the existing approval. To run the same
operations locally:

```bash
cd apps/api
npm run cf:hyperdrive:disable-cache
npm run cf:r2-cors:apply
npm run cf:hyperdrive:show
npm run cf:r2-cors:list
```

The source of truth for R2 CORS is `apps/api/r2-cors.production.json`. It allows
signed `GET` / `HEAD` / `PUT` requests from `https://videoq.jp` and only the headers
needed for video range requests. Without this configuration, browser uploads and
playback fail even when the signed URL is valid.

Database schema:

```bash
cd apps/api
npm run db:check
npm run db:verify
DATABASE_URL="<Neon pooler URL>" npm run db:migrate
```

Complete migrations before updating the API or Lambda that uses the database. CD
also enforces `db-migrate → API/worker deploy` and stops if `DATABASE_URL` is missing.

Production uses separate application, migration, and administration database roles.
See [DB_SECURITY.md](DB_SECURITY.md) for credential locations, permissions, and
rotation procedures. Do not reuse the application connection string for migrations.

## 2. API secrets

Set sensitive values with `wrangler secret put`.

```bash
cd apps/api
npx wrangler secret put BETTER_AUTH_SECRET --env production
npx wrangler secret put USER_SECRET_ENCRYPTION_KEY --env production
# Preferred: set OPENROUTER_FEDERATION_POLICY_ID and AWS_REGION in production vars.
# Fixed-key development fallback only: wrangler secret put OPENROUTER_API_KEY
npx wrangler secret put MAILGUN_API_KEY --env production
npx wrangler secret put R2_ACCESS_KEY_ID --env production
npx wrangler secret put R2_SECRET_ACCESS_KEY --env production
npx wrangler secret put SQS_QUEUE_URL --env production
npx wrangler secret put AWS_ACCESS_KEY_ID --env production
npx wrangler secret put AWS_SECRET_ACCESS_KEY --env production
# Google sign-in (optional; both required)
npx wrangler secret put GOOGLE_CLIENT_ID --env production
npx wrangler secret put GOOGLE_CLIENT_SECRET --env production
# Stripe Billing (prefer a restricted rk_ key; Checkout / Portal / webhook return 503 if unconfigured)
npx wrangler secret put STRIPE_SECRET_KEY --env production
npx wrangler secret put STRIPE_WEBHOOK_SECRET --env production
npx wrangler secret list --env production
```

`MAILGUN_API_KEY` is required in production. Verify `mg.videoq.jp` in Mailgun and
configure SPF and DKIM. In the documented account configuration, Cloudflare Email
Sending is limited to verified recipients and is unsuitable for product email, so
no binding is configured for it.

Register authorized redirect URIs for the OAuth Web client in Google Cloud Console:

- Production: `https://videoq.jp/api/auth/callback/google`
- Local: `{BETTER_AUTH_URL}/api/auth/callback/google` (for example, `http://localhost:8787/api/auth/callback/google`)

Generate `BETTER_AUTH_SECRET` and `USER_SECRET_ENCRYPTION_KEY` independently
(for example, `openssl rand -base64 48` for the auth secret).
`USER_SECRET_ENCRYPTION_KEY` must contain 32 bytes encoded as base64url. Use the
same value in the API and worker.

Non-sensitive settings (`wrangler.jsonc`, `env.production.vars`):

- `ENVIRONMENT=production`
- `BETTER_AUTH_URL` (public API origin, such as `https://videoq.jp`; the basis for cookies and the OAuth issuer)
- `FRONTEND_URL` / `CORS_ALLOW_ORIGIN`
- `R2_BUCKET_NAME` / `R2_S3_ENDPOINT` / `R2_S3_REGION` (required when `USE_S3_STORAGE=true`; missing values cause `/api/videos` to return 500)
- Embedding / LLM model
- Hyperdrive, R2, and Durable Object bindings (KV is not used)

Cookie sessions use `sameSite=lax`. Serve the frontend and API on the same site
(for example, `videoq.jp` + `/api`). Revisit cookie attributes if you separate their origins.

## 3. API deployment

The production Worker is `videoq-api`; development uses `videoq-api-dev`.
To rename an existing Worker, rename the service in the Cloudflare dashboard before
updating `wrangler.jsonc`. Changing only the configured name and deploying creates
a separate Worker, which does not inherit the Durable Object data. Check that
routes and bindings are preserved after the rename.

After CI succeeds for a push to main in the upstream repository, CD detects changes
and runs `wrangler deploy --minify --env production`
([`.github/workflows/cd.yml`](../.github/workflows/cd.yml)).
CD uses the GitHub API to revalidate the CI workflow ID, triggering event,
repository, branch, commit, and success of the latest attempt. It does not deploy
from fork/PR CI, reruns of old commits, or manual runs outside main. Manual CD also
requires successful push CI for the current main SHA. To roll back, merge a fix or
revert into main through a PR and pass CI.

### GitHub protection settings

GitHub Environments separate application and infrastructure updates to the same
production system through approval rules. `production-app` and `production-infra`
are GitHub names; they do not change Wrangler's `--env production` or production
resource names in AWS and the database. Lambda deployment does not select an
Environment and uses OIDC authentication for validated main commits.

- `main`: Require PRs, successful `CI Success`, and an up-to-date branch. Prohibit
  force pushes and deletion. Apply these rules to administrators too. The required
  number of approvals from other reviewers is currently zero because there is one
  maintainer. With multiple maintainers, require at least one approval and add
  CODEOWNERS for workflow changes.
- `production-app`: Frontend, API, and docs deployment and database migrations.
  Only the main branch can deploy; a tag with the same name is not allowed. Manual
  approval is not required; deployment follows the CI validation above.
- `production-infra`: Infrastructure and Cloudflare resource sync. Preserve manual
  approval and restrict deployments to the main branch.
- Require approval for Actions from all external contributors' forks.
- Pin Actions to full commit SHAs and update them through Dependabot.

Environment branch restrictions evaluate `GITHUB_REF` and do not replace validation
of the event that triggered `workflow_run`. CD's validation job has neither
production secrets nor OIDC permissions and executes validation code from a
trusted workflow revision. Lambda deployment and database jobs receive separate, narrowly scoped AWS OIDC permissions.

### GitHub Actions secret locations

| Secret | Location | Purpose |
|---|---|---|
| `CLOUDFLARE_API_TOKEN` | Environment secrets in `production-app` and `production-infra` | Workers deployment / checking secret names during resource sync |
| `AWS_GITHUB_ACTIONS_NEON_ROLE_ARN` | Separate `production-db-*` Environment secrets | Purpose-specific OIDC role with read access to exactly one Neon parameter; see [setup](iam/README.md#neon-database-access) |
| `AWS_GITHUB_ACTIONS_NEON_ROTATION_ROLE_ARN` | `production-infra` Environment secret | Dedicated database credential maintenance role |
| `CLOUDFLARE_INFRA_TOKEN` | Environment secrets in `production-infra` | Hyperdrive and R2 CORS updates in the target account |
| `CLOUDFLARE_ACCOUNT_ID` | Repository secrets (non-sensitive ID) | Cloudflare account ID |

The Workers deployment token grants `Workers Scripts Write` for the target account
(shown as Workers Scripts Edit / legacy in the UI) and `Workers Routes Write` for
the `videoq.jp` zone. It can also create, update, and delete other Workers in that
account, so preserve its isolation in Environment secrets.

In the deployment checked on 2026-09-18, the `Editor` role for `videoq-api` alone
failed authorization when fetching service information and uploading a version.
Adding the product's `Metadata Read-Only` role fixed only the first error; saving a
token with the product's `Editor` role failed with `Scope not found`. The
configuration therefore uses the supported `Workers Scripts Write` permission.
Once Cloudflare support is confirmed, retest deployment with permissions for the
individual Worker and narrow the scope. Deploying a Worker with R2 or Hyperdrive
bindings does not require permission to edit those resources themselves.

Restrict the resource-sync token to `Hyperdrive Write` and `Workers R2 Storage Write`
in the target account. Do not use the Global API Key. Set a 90-day lifetime and
rotate tokens with the same permissions before expiry. Record expiry dates in the
[monitoring JSON](../.github/cloudflare-token-expiry.json); GitHub Actions begins
notifications 30 days before expiry. Follow the
[rotation and notification procedure](CLOUDFLARE_TOKEN_ROTATION.md), updating the
expiry records and backup calendar reminders along with the secrets. See
[Workers roles and permissions](https://developers.cloudflare.com/workers/authorization/workers/)
and [binding permissions](https://developers.cloudflare.com/workers/authorization/#bindings)
for permission details.

When migrating from Repository secrets, re-enter the original values in Environment
secrets because GitHub does not return stored secret values. Keep values out of logs
and PRs. Confirm that all four entries in the table are registered before deleting
`CLOUDFLARE_API_TOKEN`, `DATABASE_URL`, and `CLOUDFLARE_INFRA_TOKEN` from Repository
secrets. Leaving identically named Repository secrets makes them available to
workflows without an environment, so isolation is incomplete.

Database jobs read the existing JSON SecureString
`/videoq/security/prod/db-migration` through their dedicated migration OIDC role. Other operations use separate scoped parameters; see [DB security](DB_SECURITY.md). Follow
[Neon database access setup](iam/README.md#neon-database-access) before merging
the workflow changes. After verifying database jobs, delete `DATABASE_URL` from
GitHub Environment and Repository secrets if present. `/videoq/prod/db`, referenced
by Lambda's `DB_PARAM_NAME`, is for the application only and cannot be used for
migrations. No database password reset is needed for this change.

The manual resource-sync workflow also checks that the names of all required Worker
secrets exist in production. It does not retrieve or print their values.

Manual deployment:

```bash
npm ci
npm run typecheck --workspace @videoq/api
npm test --workspace @videoq/api
npm run deploy --workspace @videoq/api
```

Verification:

```bash
curl https://videoq.jp/health
curl https://videoq.jp/ready
```

`wrangler.jsonc` retains 100% of production logs and samples 5% of traces. After
deployment, configure Workers Observability alerts for exceptions, CPU limit
exceeded events, and `external_task_backlog_warning`.

## 4. Worker infrastructure

Terraform manages the AWS asynchronous infrastructure, including SQS, the worker
Lambda (**arm64**), ECR, IAM, and SSM Parameter Store.

### Migrate from Secrets Manager to SSM (existing environments)

Store worker secrets as **SSM SecureString** parameters
(`/videoq/<env>/db`, `/videoq/<env>/app`). Copy the values before `terraform apply`
deletes the old Secrets Manager resources.

```bash
REGION=ap-northeast-1

# 1) Read the current Secrets Manager values
DB_JSON=$(aws secretsmanager get-secret-value \
  --secret-id videoq/prod/db --region "$REGION" \
  --query SecretString --output text)
APP_JSON=$(aws secretsmanager get-secret-value \
  --secret-id videoq/prod/app --region "$REGION" \
  --query SecretString --output text)

# 2) Write to SSM (create missing parameters or overwrite existing ones)
aws ssm put-parameter --region "$REGION" \
  --name /videoq/prod/db --type SecureString \
  --value "$DB_JSON" --overwrite
aws ssm put-parameter --region "$REGION" \
  --name /videoq/prod/app --type SecureString \
  --value "$APP_JSON" --overwrite

# 3) Import parameters into Terraform state if they were created manually
cd infra
terraform import aws_ssm_parameter.db /videoq/prod/db
terraform import aws_ssm_parameter.app /videoq/prod/app

# 4) Remove old Secrets Manager resources from state before applying, because they use prevent_destroy
terraform state rm aws_secretsmanager_secret.db
terraform state rm aws_secretsmanager_secret.app

# 5) Delete old secrets manually to stop billing (use a recovery window if needed)
aws secretsmanager delete-secret --region "$REGION" \
  --secret-id videoq/prod/db --force-delete-without-recovery
aws secretsmanager delete-secret --region "$REGION" \
  --secret-id videoq/prod/app --force-delete-without-recovery
```

In a new environment, `terraform apply` creates SSM parameters with placeholder
values. Immediately set the real values with `put-parameter --overwrite` as above.
Terraform ignores `value`, so subsequent applies do not overwrite them.

```bash
cd infra
cp backend.hcl.example backend.hcl
cp terraform.tfvars.example terraform.tfvars
terraform init -backend-config=backend.hcl
terraform plan
terraform apply
```

If you changed the IAM policy JSON, replace `videoq-terraform-deploy` following
`infra/iam/README.md` before applying.

GitHub Actions uses separate OIDC roles for plan and deployment instead of static
AWS access keys. See [`iam/README.md`](iam/README.md) for initial setup and the
Repository secrets `AWS_GITHUB_ACTIONS_PLAN_ROLE_ARN` and
`AWS_GITHUB_ACTIONS_DEPLOY_ROLE_ARN`.

If the existing Lambda has run before, AWS has already created its CloudWatch Logs
group. The declarative `import` block in `monitoring.tf` imports that group into
state on the first apply; Terraform then manages it as a normal resource.

Set `operations_alert_email` to receive SNS email alerts for Lambda errors, failed
jobs, throttling, long executions, SQS backlog, and DLQ arrivals. After applying,
confirm the subscription through the email AWS sends. `lambda_log_retention_days`
controls log retention (30 days by default).

Separate alarms monitor queue backlog and execution duration. All alarms notify
on both ALARM and recovery to OK. An OK email does not report a new failure.

| Alarm suffix | Condition |
|---|---|
| `job-failures` | At least one failed SQS event in a five-minute sum, including failures returned through `batchItemFailures` |
| `queue-waiting` | At least one visible waiting message in the one-minute minimum for five consecutive periods |
| `queue-depth` | At least 10 waiting messages in the five-minute maximum for two consecutive periods |
| `duration` | Maximum execution time in a 15-minute period reaches 80% of the Lambda timeout (12 minutes by default); a single execution can trigger it |

`queue-waiting` detects a persistent backlog across the queue; it does not measure
individual jobs' waiting times. It uses
[SQS visible message counts](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-available-cloudwatch-metrics.html),
so an in-flight job taking eight or nine minutes with no waiting messages does not
trigger this alarm. Applying replaces the old `queue-age` alarm with `queue-waiting`.

`job-failures` enables `EventCount` on the event source and monitors
[`FailedInvokeEventCount`](https://docs.aws.amazon.com/lambda/latest/dg/monitoring-metrics-types.html#event-source-mapping-metrics)
by `EventSourceMappingUUID`. Lambda's `Errors` metric cannot detect a failure when
the handler catches an exception and returns `batchItemFailures`. This metric is
recorded at completion, so failures can be reported independently of backlog or
execution duration while failed jobs are invisible until retry. An OK notification
from `job-failures` means no failures were detected in the latest evaluation; it
does not prove that the affected job's retry succeeded. Check `job_executions` and
worker logs for retry outcomes.

[Lambda duration metrics](https://docs.aws.amazon.com/lambda/latest/dg/monitoring-metrics-view.html)
are sent after execution completes, with the start time as their timestamp.
Consequently, `duration` is not an immediate alert during execution. A 15-minute
aggregation period allows evaluation of late-arriving metrics from long executions.

RAGAS evaluation has been removed. Releasing both the API and worker stops new
evaluation jobs from being created or delivered, and queued evaluation jobs finish
without calling AI. Historical evaluation tables remain. Let evaluations running
on the old worker finish before switching.

**arm64 cutover:** Lambda's `architectures = ["arm64"]` must match the image architecture.

Set SQS `sqs_visibility_timeout_seconds` to at least six times the Lambda timeout
(5400 seconds for the default 900-second timeout). Set `sqs_max_receive_count` to at
least five. These values follow
[AWS recommendations](https://docs.aws.amazon.com/lambda/latest/dg/services-sqs-configure.html)
to allow retries during throttling. Failed messages may take up to 90 minutes to
become available again, so monitor backlog and check the DLQ too. If an existing
`terraform.tfvars` uses 960 seconds / three receives, update the values before
planning; Terraform input validation rejects those settings.

**Push an arm64 image to ECR** using the procedure below before `terraform apply`.
Changing only the architecture while keeping an amd64 image causes the update to fail.

Worker image (**linux/arm64**):

```bash
REGION=ap-northeast-1
WORKER_ECR=<account>.dkr.ecr.$REGION.amazonaws.com/videoq-worker-prod

aws ecr get-login-password --region "$REGION" |
  docker login --username AWS --password-stdin "${WORKER_ECR%%/*}"

docker buildx build --platform linux/arm64 --provenance=false --push \
  -f apps/worker/Dockerfile -t "$WORKER_ECR:latest" ./apps/worker

aws lambda update-function-code \
  --function-name videoq-worker-prod \
  --image-uri "$WORKER_ECR:latest" \
  --region "$REGION"
```

### Cloud transcription (OpenRouter)

The cloud worker uses `WHISPER_BACKEND=openrouter`. Set Terraform
`openrouter_federation_policy_id` after configuring AWS outbound federation and
OpenRouter trust; the Lambda execution role supplies its identity. No OpenRouter
fixed key is required in the SSM parameter for WIF. Modal is retired; no Modal CLI or
GitHub credentials are required. See
[the switch runbook](../docs/operations/openai-transcription.md) for the
in-flight job check, config refresh and retirement order.

## 5. Frontend

The frontend uses the dedicated Worker `videoq-web` with Static Assets.
`apps/web/wrangler.jsonc` is the source of truth and manages the Custom Domains
`videoq.jp` and `www.videoq.jp`. The www domain redirects to the same path on
`https://videoq.jp`.

After push CI succeeds on main, CD's `web-deploy` builds and publishes the validated
SHA. Change detection covers `apps/web/**`, `packages/trpc/**`, the root package
manifest and lockfile, CI/CD workflows, and `.github/scripts/**`. When the API also
changes, frontend deployment waits for the API deployment to succeed. Frontend-only
changes do not require an API deployment.

Only the publishing step receives `CLOUDFLARE_API_TOKEN` from `production-app` and
`CLOUDFLARE_ACCOUNT_ID`. It needs permission to edit Worker Scripts, edit Worker
Routes for the target zone, and manage Custom Domains. GitHub Actions CD manages
publishing.

```bash
# repository root
npm ci
npm run build
npm run test:worker --workspace @videoq/web
npm run deploy --workspace @videoq/web
```

Vite's public variables live in `apps/web/.env.production`:
`VITE_API_URL=/api`, `VITE_USE_S3_STORAGE=true`, and
`VITE_MAX_VIDEO_UPLOAD_SIZE_MB=500`. API limits apply separately.
`worker/index.ts` adds language-specific SEO information to HTML and sets shared
security headers for HTML and static files. `/assets/*` is served directly by
Static Assets without running the Worker.

The API Worker remains independent. The routes `videoq.jp/api/*`,
`videoq.jp/.well-known/*`, `videoq.jp/health`, and `videoq.jp/ready` in
`apps/api/wrangler.jsonc` take precedence over the Custom Domain, so the frontend
needs neither an API proxy nor a Service Binding.

### Local verification and rollback

`npm run preview:worker --workspace @videoq/web` previews the built frontend locally.
It returns noindex and does not connect to the production API.

For a normal rollback, run `npx wrangler rollback --env production` from `apps/web`.
This restores a deployment from Workers history while preserving the production
domain and the four API routes.

## 5.1 Documentation

Documentation is published as static files by the dedicated Cloudflare Worker
`videoq-docs`. English is at `https://docs.videoq.jp/` and Japanese at
`https://docs.videoq.jp/ja/`. This deployment is independent of the `videoq-web` app.

After push CI succeeds on main, CD's `docs-deploy` detects changes and automatically
publishes both languages. It watches `docs/**`, `apps/docs/**` (including Japanese
translations), the root `package.json` and `package-lock.json`, CI/CD workflows,
and `.github/scripts/**`. Detection compares against the last successful CD run,
so it includes document changes in commits whose CI was canceled along the way.

The job checks out the validated main SHA, type-checks, and builds. Only the
publishing step receives `CLOUDFLARE_API_TOKEN` from `production-app` and
`CLOUDFLARE_ACCOUNT_ID` from Repository secrets. The docs job is independent of the
API, Lambda, and database jobs; docs-only changes do not update those services.
PRs and pushes to feature branches do not publish. A manual CD run from main first
confirms successful push CI for the same SHA, then republishes docs along with the
other deployment targets.

To publish manually from a local checkout, run from the repository root:

```bash
npm ci
npx wrangler login
npm run deploy:docs
```

This command builds both languages from the current working tree and uploads
`apps/docs/build` as the Worker's static assets. It includes uncommitted document
changes. `apps/docs/wrangler.jsonc` is the source of truth for the publishing target.

The Custom Domain `docs.videoq.jp` is declared in Wrangler's `routes` with
`custom_domain: true`. Cloudflare configures the DNS record and HTTPS certificate
during deployment. `workers.dev` and preview URLs are disabled. Trailing slashes
are preserved; missing paths return the Docusaurus 404 page.

See [apps/docs/README.md](../apps/docs/README.md) for details.

## 6. Historical cutovers

The one-time Django table-copy and cleanup tools have been retired. For an existing
VideoQ installation, use `npm run db:migrate` through the normal deployment path.
Historical cutover procedures and tools remain available in Git history; do not
repeat them on an existing Better Auth deployment.

## 7. Initial Better Auth cutover (destructive, legacy 0005)

After applying `0005_better_auth`:

- Old passwords, browser sessions, API keys, OAuth clients, and tokens are invalid.
- Existing users **must reset their passwords**; credential `account` rows are created with empty passwords.
- SearchAPI keys are cleared and must be entered again.
- MCP / third-party OAuth clients must be registered again.

Operational procedure:

1. Back up the database.
2. Enter a maintenance window and stop API writes.
3. Run `DATABASE_URL=... npm run db:migrate`, including `0005_better_auth`.
4. Check secrets and variables (`BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`).
5. Deploy the API and frontend together.
6. Notify users to reset passwords and reissue API keys, OAuth registrations, and SearchAPI keys.

This section applies only to the first migration from legacy authentication to
`0005_better_auth`. Do not repeat it to upgrade an existing Better Auth deployment to 1.7.

## 8. Better Auth 1.7 migration (Claude client re-registration)

Migrations `0017_invalidate_legacy_oauth_grants` through `0020_finalize_better_auth_issuer`
delete existing external OAuth clients, consents, access tokens, and refresh tokens
to switch safely to Better Auth 1.7 resource-bound tokens. They preserve browser
sessions, API keys, and `account` records such as Google sign-in, and backfill account
issuers by legacy provider. The MCP protected resource is seeded per environment
from `BETTER_AUTH_URL` at API startup, without embedding production URLs in migration SQL.

Schema migrations `0018` and `0020` are unedited output from `drizzle-kit generate`.
Only data migrations `0017` and `0019` use `drizzle-kit generate --custom`.

Back up the database and check for duplicate accounts before applying. If this query
returns any rows, stop the migration and resolve the cause.

```sql
SELECT provider_id, account_id, count(*)
FROM account
GROUP BY provider_id, account_id
HAVING count(*) > 1;
```

```bash
cd apps/api
DATABASE_URL="<Neon direct connection URL>" npm run db:migrate
```

After applying, remove the old VideoQ connection from Claude Code and register it
again with `claude mcp add`. Verify `tools/list` and a read tool. For a connection
with approved write scope, also verify one write tool call with an idempotency key.

## 9. Release verification

- `/health` and `/ready`
- Signup / login / logout with cookie sessions
- Existing users can log in after resetting their passwords, and their old passwords are rejected
- API key reissuance and MCP tool calls using `Authorization: Bearer` / `X-API-Key`
- OAuth client re-registration and SearchAPI key re-entry only for the legacy 0005 cutover
- R2 signed uploads and video finalization
- R2 CORS (`npm run cf:r2-cors:list --workspace @videoq/api`)
- Hyperdrive query cache disabled (`npm run cf:hyperdrive:show --workspace @videoq/api`)
- Mailgun signup verification / password reset / course invitation
- SQS enqueue and worker completion
- Chat / SSE with `credentials: include`
- tRPC query/mutation from the SPA
- OAuth discovery / DCR / PKCE
- MCP initialize / tools list / read tool / idempotent write tool
- After the Better Auth 1.7 migration, old Claude Code tokens are rejected and re-registered connections work
- CloudWatch alarm states and SNS subscription confirmation

Check both Cloudflare Workers logs and Lambda CloudWatch logs.
