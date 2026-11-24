# Deploy VideoQ

Production resources and active state are managed as described in
[Terraform ownership and R2 state](TERRAFORM.md). Use that runbook for imports,
provider credentials, state recovery and infrastructure changes.

## Production architecture

- Web and docs: Cloudflare Workers with Static Assets.
- API: Hono on Cloudflare Workers.
- Database: Cloudflare D1; PostgreSQL is used by the on-premises edition.
- Media storage: private Cloudflare R2 with the Terraform-managed browser CORS rule.
- Search/account jobs: Cloudflare Queues and a search-index Workflow.
- Media jobs: Amazon SQS and the remaining Python Lambda.
- Maintenance ownership: a Cloudflare Worker and SQLite Durable Object.

## Application deployments

Merge reviewed changes into main. Successful main CI starts CD. Build jobs do
not receive production credentials; deployment jobs consume the immutable artifact
from the same run and apply the appropriate Terraform release state in R2.
The maintenance Worker uses its separate protected deployment workflow.

Do not run a production `wrangler deploy`, queue creation script or CORS update.
Package `deploy` commands request the reviewed-main CD workflow through GitHub.
`Sync Cloudflare Resources` delegates to the Terraform infrastructure workflow.
The former Neon Hyperdrive is retired and must not be recreated.

Keep the existing D1/backend/admission checks immediately before an API release.
An active maintenance pause, changed database binding, mixed vector targets or
unexpected active Worker version must fail deployment until reconciled.

## Infrastructure deployments

Use `Cloudflare Infrastructure` for the Cloudflare foundation and R2 state bucket.
Use the protected Terraform Apply workflow for `infra/`. Independent archive,
identity, AWS-state archive and evaluation roots are operator-managed Terraform
states; validate an exact plan before applying them. Use the R2 credentials wrapper
for every live command and preserve production `prevent_destroy` protections.

Credential issuance/rotation remains in the credential stores; do not commit
secret values or use Terraform to replace production credentials with placeholders.
D1 schema migrations and application backups remain operational workflows rather
than Terraform data resources. See the maintenance runbook for ownership/recovery.

## Contact and monitoring

Use `alerts@videoq.jp` for operational notifications and `support@videoq.jp` for
customer-facing support. Terraform owns DNS records and Email Routing rules;
forwarding destinations are private infrastructure inputs in GitHub Secrets.
Confirm delivery before changing a published address. Confirm a replacement SNS
email subscription before retiring its predecessor. Keep `OPERATIONS_ALERT_EMAIL` aligned with the confirmed destination.

## Historical resources

The old AWS state bucket, database archives, maintenance logs and retained control
parameter metadata are protected Terraform resources. Their continued presence is
intentional recovery/audit retention. The old search/account Lambdas, SQS queues
and AWS maintenance executors have already been retired. The active RateLimiter, TaskScheduler, ChatExecution and MaintenanceCoordinator
SQLite namespaces retain application state and are protected. Other projects
sharing Cloudflare/AWS accounts are outside VideoQ deployment and cleanup scope.
