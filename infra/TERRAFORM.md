# Terraform ownership and R2 state

VideoQ's cloud resource definitions live in Terraform. Existing production
resources are imported; adopting D1, R2, Vectorize or Durable Objects must never
replace their storage. Other applications in the shared cloud accounts are out
of scope.

## State roots

All active state uses the S3-compatible backend at the **R2** endpoint and the
private `videoq-terraform-state-prod` bucket. The backend type remains `s3`;
it does not refer to AWS S3. Terraform 1.15.1 is the reviewed runtime.

| Root | R2 object key | Ownership |
|---|---|---|
| `infra/` | `videoq/prod/terraform.tfstate` | Media Lambda, SQS/DLQ, ECR, runtime IAM, SSM and alarms |
| `infra/bootstrap/` | `videoq/bootstrap/terraform.tfstate` | Retained historical AWS state bucket |
| `infra/db-maintenance/terraform/` | `videoq/prod/db-maintenance.tfstate` | Retained archive, historical logs and worker boundary |
| `infra/r2-state/` | `videoq/bootstrap/r2.tfstate` | Private state bucket and immutable recovery history |
| `infra/cloudflare/` | `videoq/prod/cloudflare.tfstate` | Zone/DNS, email rules, Workers metadata, routes/domains, D1, R2/CORS/lifecycle, queues/consumers, Workflow and Vectorize/indexed metadata |
| `infra/cloudflare-releases/api/` | `videoq/prod/workers/api.tfstate` | API code, bindings, Durable Object declarations and active deployment |
| `infra/cloudflare-releases/web/` | `videoq/prod/workers/web.tfstate` | Web code, bindings, assets and active deployment |
| `infra/cloudflare-releases/docs/` | `videoq/prod/workers/docs.tfstate` | Docs assets and active deployment |
| `infra/cloudflare-releases/maintenance/` | `videoq/prod/workers/maintenance.tfstate` | Coordinator code, Durable Object binding and active deployment |
| `infra/identity/` | `videoq/prod/identity.tfstate` | OIDC roles/policies, legacy credential metadata, retained control parameters and API logs |
| `infra/search-evaluation/` | `videoq/prod/search-evaluation.tfstate` | Independent, disabled evaluation Lambda and logs |

The old AWS state bucket retains its original versions for recovery. It is not
an active backend. Do not resume an older checkout against its former S3 state.
Do not delete that archive while recovery retention is required.

## Credentials, locking and recovery

Use `node infra/bin/terraform-r2.cjs -chdir=infra/<root> ...` instead of invoking
Terraform directly against a live backend. It requires these environment
variables, supplied by the operator's credential manager or GitHub Secrets:

- `TF_STATE_R2_ACCESS_KEY_ID`
- `TF_STATE_R2_SECRET_ACCESS_KEY`

The R2 token has Object Read & Write access to the state bucket only. Never
reuse the media bucket token. The wrapper writes a private, temporary credentials
file with separate backend and AWS-provider profiles, removes conflicting AWS
credential environment variables from the child, and deletes the file afterwards.
Provider credentials must never appear in backend arguments, HCL, plans or logs.

Native `use_lockfile` is enabled. A live two-process test verified that the second
Terraform process cannot acquire the lock while the first holds it, and can
proceed after release. Never use `-lock=false` or force-unlock a live owner.

R2 does not implement S3 bucket versioning. Before an apply, the wrapper saves the
current state under `history/<state-key>/<timestamp>-<uuid>-<sha256>.json` with a
conditional create. A bucket lock prevents modification/deletion of history for
90 days. Current state and `.tflock` objects are outside that prefix. No public
R2 domain or CORS is enabled for the state bucket. R2 encrypts data at rest;
do not send AWS S3 `encrypt=true`/SSE headers to this backend.

For recovery, stop all writers, preserve the current state privately, verify a
snapshot's hash/lineage/resource identities, and use Terraform `state push`
without `-force`. Restore object ownership before re-enabling writers. Never
publish raw state, plans, provider responses or secret values as Actions artifacts.

## Resource and release ownership

- `Cloudflare Infrastructure` plans/applies the foundation and state-bucket roots
  from successful, current main under `production-infra` protection. The old
  `Sync Cloudflare Resources` entry point delegates to that same owner.
- CD builds application artifacts without production credentials. The upload
  jobs run Terraform; Wrangler is used only for local builds/dry runs. Worker
  versions and deployments use create-before-destroy. The provider retains old
  versions/deployments for rollback; it does not delete their history.
- Worker release code inherits each existing secret from the exact deployed
  version. It never reads secret values. It preserves Durable Object namespace
  IDs and rejects an unreviewed migration tag/class change. Adding or renaming
  classes requires a reviewed Terraform migration input, not an incidental CD.
- Secret inheritance is a write-only upload operation: the API reads the result
  back as `secret_text`. A fresh release deliberately uploads a new immutable
  version. To inspect existing release state without proposing another upload,
  use `plan -refresh-only` with `release={}` and independently check the live
  deployment ID. Never apply a release from reconstructed historical artifacts.
- Cloudflare provider 5.29 lacks Vectorize resources and queue-consumer import.
  The pinned REST provider owns those CRUD APIs and detects configured-field
  drift. Vector index definitions and metadata types are immutable and protected
  from destruction. Initial REST imports were adapted only after exact API reads;
  refresh plans must be clean before any future apply.
- The API daily cron remains `17 3 * * *`. Provider 5.29 does not refresh
  cron schedules; an independent read-only API observation validates every
  Worker schedule and blocks silent drift.
- Queues' `delivery_paused` is deliberately owned by the maintenance admission
  protocol; Terraform owns queue existence and retention. Do not undo a live
  maintenance lease with an infrastructure apply.
- AWS media image releases remain application artifacts deployed by their
  dedicated CD job; Terraform owns the Lambda's infrastructure and runtime role.

Application data (D1 rows, vectors, R2 objects and Durable Object SQLite contents),
platform-generated DNS/namespace identities, account billing and bootstrap
credentials are not separate Terraform-managed data objects. Bootstrap API-token
issuance, account access and GitHub Secret values remain in their credential
stores. Terraform manages SSM parameter metadata with write-only inputs: current values
are excluded from state and remain under credential-rotation ownership. Imported IAM access keys retain their existing
IDs; their secret halves are never recovered or regenerated by this migration.

## Operating safely

Run imports and plans with private inputs (`umask 077`), compare live resource
identities, and retain `prevent_destroy` on production storage and identities.
The identity root needs an operator credential; the application deployment role
must not grant itself broader IAM permissions. Historical logs/control credentials
are retained for audit and controlled recovery, not automatically removed.

`infra/` plans must use the three current migration flags from GitHub variables:
`CLOUDFLARE_BACKGROUND_JOBS_ROUTING_ENABLED`,
`CLOUDFLARE_BACKGROUND_JOBS_ENABLED`, and `RETIRE_BACKGROUND_QUEUES`. All are true
after the completed migration. Omitting them would propose retired AWS resources.
The maintenance-archive root also requires `retire_aws_maintenance=true`.
