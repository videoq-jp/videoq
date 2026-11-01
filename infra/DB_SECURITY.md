# Production database access

The service keeps Cloudflare Workers → Hyperdrive → Neon. PostgreSQL password
authentication remains; passwords live in Hyperdrive/SSM and rotate independently
of the stable roles that own objects or hold grants. All direct connections use
`sslmode=verify-full`. Lambda explicitly uses the Amazon Linux CA bundle;
backup pg_dump receives a read-only mount of the runner CA bundle. Hyperdrive retains its existing server-certificate validation
and query caching stays disabled.

## Purpose boundaries

The authoritative profile map is [.github/scripts/neon-profiles.json](../.github/scripts/neon-profiles.json).

| Consumer | Stable access role | Credential location | GitHub Environment |
|---|---|---|---|
| Workers API | `videoq_api_access` | Hyperdrive and `/videoq/prod/db` | none |
| Lambda | `videoq_worker_access` | `/videoq/prod/worker-db` | none |
| Migrations | `videoq_migrate_20260918` (schema owner) | `/videoq/security/prod/db-migration` | `production-db-migration` |
| Logical backup/restore | `videoq_backup_access` | `/videoq/security/prod/db-backup` | `production-db-backup` |
| Public demo audit | `videoq_audit_access` | `/videoq/security/prod/db-audit` | `production-db-audit` |
| Production smoke | `videoq_smoke_access` | `/videoq/security/prod/db-smoke` | `production-db-smoke` |
| Public demo preparation | `videoq_demo_access` | `/videoq/security/prod/db-demo` | `production-db-demo` |

Each GitHub Environment permits only canonical `main`. Migration, backup, smoke
and maintenance jobs store a request-role ARN in
`AWS_GITHUB_ACTIONS_DB_REQUEST_ROLE_ARN`; these roles can invoke only their fixed
AWS starter alias. They cannot fetch SSM values, upload executable bundles,
start arbitrary builds, or update AWS maintenance code/roles. The demo/audit
Environments retain their separate exact-parameter readers in
`AWS_GITHUB_ACTIONS_NEON_ROLE_ARN`. AWS job roles enforce the same purpose map.
The application Environment has no database credential. PR workflows never
receive AWS planning credentials or production state. The main-only planning role
explicitly denies protected SSM values/history and recursive parameter reads.
Lambda can read its own DB parameter and application settings, and cannot read
API, migration, audit or backup credentials.

The API has DML on current application tables, without access to retired Django
and OAuth tables. It cannot create/drop objects or access the migration ledger.
The worker inherits the existing column-scoped processing/deletion permissions
through `videoq_worker_20261014`, plus the current embedding-table grants. That
legacy role becomes NOLOGIN; it is retained for its grants. New worker tables and
columns require an explicit privilege review in their schema change.

Backup has SELECT on application, migration and security tables, including the
smoke identity registry. The logical dump/restore includes all three schemas.
Audit can SELECT only views for the dedicated public demo. It cannot read password
hashes or execute the demo preparation function.

Smoke can SELECT only views for identities recorded in the private smoke registry.
Matching an `ops_smoke_*` username alone does not grant eligibility. SECURITY
DEFINER functions can create a test identity with fixed quotas, reset only that
identity's credential, shorten its session and delete it after video cleanup.
The smoke login has no direct writes to users/accounts/sessions and cannot read
password hashes. Demo preparation has a separate function that validates the fixed
demo identity and preserves usage counters. Public EXECUTE is revoked; functions
use an explicit search_path and qualified object names. These controls are in
[infra/sql/neon-security.sql](sql/neon-security.sql).

## AWS execution and automatic rotation

EventBridge Scheduler checks ages daily; credentials rotate at 90 days. Step
Functions Standard sequences scoped CodeBuild jobs and waits without keeping a
build running during the invocation grace period. Manual requests use
[Maintain Neon Credentials](../.github/workflows/neon-credentials.yml), which
invokes the fixed AWS starter and observes metadata. GitHub receives no DB URL,
DB administrator credential or Hyperdrive maintenance token from this flow.

1. Persist encrypted recovery material before creating new purpose LOGIN roles.
2. Verify actual allowed operations and SQLSTATE 42501 denials. Migration URLs set
   the stable schema-owner role at connection startup.
3. Change Hyperdrive's origin login, preserve TLS, keep caching disabled, update
   the exact SSM parameters, and refresh Lambda with its dedicated parameter.
4. Run AWS production smoke, logical backup/restore and read-only demo audit.
5. Wait at least the maximum Lambda invocation lifetime (15 minutes) plus one
   minute after configuration refresh.
6. Refuse retirement while an old role has an active query. Disable old logins,
   clear passwords, terminate only idle sessions and prove old credentials fail.
7. Recheck current privileges and run production smoke after retirement.
8. Only then remove recovery credentials from the current journal value.

The global DynamoDB lock serializes AWS rotation, migration, backup and smoke.
It does not expire based on elapsed time. Failed rotations block migrations until
explicit recovery; the starter checks execution/build status before resuming.
The workflow never automatically retries credential mutations. Manual `rotate`
resumes the persisted phase; `rollback` restores old consumers, checks production,
waits, disables abandoned candidates and checks production again.

Only metadata enters Step Functions history and starter responses. Credential
reads stay inside AWS job processes; raw SQL/HTTP/subprocess errors are captured.
CLI secret inputs use private temporary files. GitHub masking commands are never
used in CloudWatch. Old SSM versions remain protected; retired passwords no longer
authenticate. The break-glass `neondb_owner` credential remains manually managed
in `/videoq/security/prod/db-admin` outside automatic service-login rotation.

The privileged operator bundle uses an immutable S3 object version. After successful
current-main CI, an invocation-only GitHub role requests the AWS deployment builder
to promote code, source versions and aliases. That builder cannot read SSM secrets
or edit IAM, but approved code can exercise the DB jobs' existing privileges.
Main review remains an administrative trust boundary. IAM/infrastructure and the
independent Terraform state remain operator-managed and inaccessible to GitHub
request roles. Terraform preserves CD-owned versions and definitions.
Migrations and deployments independently validate the requested canonical-main SHA.
AWS execution does not eliminate the risks of malicious approved code or dependencies.

See [AWS database maintenance](db-maintenance/README.md) for packaging, infrastructure,
verification, staged cutover, retirement of old GitHub reader roles and recovery.

## Connection-source restrictions

Production currently uses Neon Free. IP allowlisting is a separate paid rollout
after reviewing the plan and all egress paths. Neon IP Allow requires the Scale plan. Hyperdrive uses shared Cloudflare IP
ranges, not a unique source IP for this account. The current Lambda has no VPC,
and standard GitHub-hosted runners do not provide a dedicated fixed egress IP.
Enabling an allowlist now would block valid production/migration connections.

Prepare fixed egress for Lambda and the production runners, include Hyperdrive,
backup/rotation and emergency administration, and price the Neon plan/networking
before requesting approval for paid changes. Test allowed and denied connections
before restricting the production branch. IP allowlisting supplements database
identity checks; shared Cloudflare ranges do not identify a particular tenant.

### Initialize Hyperdrive maintenance access

Run `infra/scripts/setup_neon_access.py` with the setup administrator identity to
provision the main-only maintenance environment and the separate bootstrap role.
After merging, dispatch `Initialize Neon Maintenance` on main and approve its
existing `production-infra` environment review. This validates the configured
Hyperdrive/Neon target and stores the Cloudflare credential in the protected SSM
parameter `/videoq/security/prod/hyperdrive-credentials`. The bootstrap role can
only write that parameter; scheduled maintenance can read it. Repeat this handoff
when `CLOUDFLARE_INFRA_TOKEN` is renewed. Existing infrastructure review rules are
preserved; scheduled rotation needs no human approval.
