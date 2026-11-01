# Production service connection review — 2026-11-01

This is a point-in-time review of the hosted API, worker, queues, database and
media storage. It is not a penetration test or a claim that all application
security properties have been verified. Secret values and user content are not
included in this report.

## Verified configuration

| Connection | Evidence | Limits |
| --- | --- | --- |
| API → SQS | The API IAM user has only `sqs:SendMessage` on the production worker queue plus constrained `sts:GetWebIdentityToken`. It has no group memberships or attached managed policies. One active key was created on October 31. | Cloudflare uses a long-lived AWS key; OpenRouter federation does not eliminate that key. |
| SQS → Lambda | The worker execution role can access only its queue and the application/worker DB SSM parameters. Its only attached managed policy is basic Lambda logging. | This review did not enumerate every other principal in the account that may access SQS. |
| Main queue and DLQ | Both have SQS-managed encryption at rest. On November 1, an explicit `DenyInsecureTransport` queue policy was applied to both and read back. IAM simulation returned `explicitDeny` for `aws:SecureTransport=false` and `allowed` for true with an otherwise allowed identity policy. HTTPS attribute reads continued to work. | The transport simulation does not grant an identity access. The test did not send production messages over HTTP. |
| API and worker → Neon | Separate current login roles are stored in separate SSM parameters. Both URLs use `sslmode=verify-full`; connections from the operator environment succeeded with the system CA bundle and the driver reported TLS active. Both roles lack superuser, database/role creation, replication, RLS bypass and database/public-schema creation privileges. | These operator connections alone do not prove the deployed clients' behavior. Neon's proxy can make `pg_stat_ssl` describe a different hop; the client TLS flag was checked separately. |
| Hyperdrive → Neon | The live configuration uses the current API login and the expected Neon pooler. Query caching is disabled. The `mtls` object is empty, so the documented default TLS mode applies. | Hyperdrive's TLS mode is separate from SSM's PostgreSQL URL. The default is TLS `require` with WebPKI certificate validation; do not infer `verify-full` from the SSM URL. |
| R2 public access | The production bucket's `r2.dev` domain is disabled and there are no custom domains. CORS allows only `https://videoq.jp`, with GET/HEAD/PUT. | CORS is a browser control, not an authorization boundary. Presigned URLs remain bearer credentials until expiration. |
| Worker → R2 | The worker uses an HTTPS R2 endpoint. A random nonexistent-key read in the production bucket returned `NoSuchKey`; the same probe in the account's other existing bucket returned `AccessDenied`. Bucket enumeration was denied. | This demonstrates the tested access behavior, not the token's complete policy or its behavior for future buckets. The API's secret value cannot be read back from Workers to compare credentials. |
| API/worker → OpenRouter | The read-only production credential workflow passed its checks for the expected, separate federation policy IDs, the HTTPS OpenRouter endpoint and no purpose-endpoint overrides. It also confirmed that the former direct OpenAI key is absent from the API and worker app parameter. AWS IAM restricts token audience, signature algorithm and duration to the intended OpenRouter audience, RS256 and at most 900 seconds. | OpenRouter-side subject/issuer/key binding and workspace key scope still require management access. Successful inference alone cannot prove those restrictions. |

Hyperdrive's documented TLS behavior:
[SSL/TLS certificates](https://developers.cloudflare.com/hyperdrive/configuration/tls-ssl-certificates-for-hyperdrive/).
SQS transport policy guidance:
[Amazon SQS security best practices](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-security-best-practices.html).

## Validation and evidence

- `terraform fmt -check -recursive`, `terraform validate`, and all seven root
  Terraform tests pass locally. `tests/sqs-transport.tftest.hcl` checks both queue
  targets and the complete transport-denial conditions.
- The production credential audit ran with `operation=plan` (read only):
  [run 41305095039](https://github.com/videoq-jp/videoq/actions/runs/41305095039).
- Production smoke with `verify_ai_answers=true` succeeded after the SQS
  policy change:
  [run 41305097188](https://github.com/videoq-jp/videoq/actions/runs/41305097188).
  The underlying AWS execution `902dafc4b0ec1deac4f618ddd4fd0b92` also reached
  `SUCCEEDED`, and its recorded input confirms the AI-answer option was enabled.
  The check covers public readiness, signed-in upload, transcription, embeddings,
  cited Q&A, course-scoped/unscoped streaming, browser access and synthetic-data
  cleanup. This proves the exercised paths worked; it does not certify all
  authorization boundaries.
- The live worker has `PGSSLROOTCERT=/etc/pki/tls/certs/ca-bundle.crt`, is active
  and reports a successful last update. Its production smoke exercised the actual
  worker DB connection; no TLS-verification downgrade was used.
- Terraform source and regression checks are in
  [PR #1302](https://github.com/videoq-jp/videoq/pull/1302). The queue policies were
  applied directly without changing Terraform state. When this source is merged,
  Terraform can adopt them with its ordinary queue-policy create/update calls;
  verify a saved production plan before applying. Do not remove the live denies
  merely to make a plan empty.

## Remaining management checks

1. Inspect both OpenRouter federation policies. Confirm exact AWS issuer,
   workload subject, audience, inference-only scope and the intended workspace
   key. Reject unrelated workloads; do not use inference success as proof of
   exact policy scope.
2. Inspect the API and worker R2 tokens' complete policies. Confirm that object
   permissions cover only the production media bucket, without account-wide
   administration or other bucket access. The available Cloudflare maintenance
   token cannot list user/account token policies (HTTP 403).

The local Docker Compose stack is development infrastructure. Several host port
mappings listen on all interfaces; do not expose that stack directly to an
untrusted network. This production SQS change does not modify those mappings.
