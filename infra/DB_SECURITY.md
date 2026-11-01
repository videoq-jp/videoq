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

Each GitHub Environment permits only the canonical `main` branch, has its own
OIDC role, and stores only that role ARN in `AWS_GITHUB_ACTIONS_NEON_ROLE_ARN`.
Each IAM role can read exactly one parameter. A different purpose argument to the
wrapper therefore cannot obtain another consumer's credential. The application
Environment has no database credential. Lambda can read its own DB parameter and
application settings, and cannot read API, migration, audit or backup credentials.

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

## Automatic rotation

[Maintain Neon Credentials](../.github/workflows/neon-credentials.yml) checks daily
and rotates service/operations credentials when they reach 90 days. Manual runs
default to an age audit; choose `rotate` to resume an unfinished rotation or set
`force` to rotate sooner. It runs in `production-infra` using a dedicated rotation
role, not the Terraform deployment role. The workflow and CD migration job share
`production-db-maintenance` concurrency and never cancel an active rotation.

1. Generate new random LOGIN roles and persist encrypted recovery material in
   `/videoq/security/prod/db-rotation` before making any consumer change.
2. Grant each login only its stable access role. Verify actual allowed operations
   and SQLSTATE 42501 denials. Migration URLs set the stable schema-owner role at
   connection startup so new objects/default grants do not belong to a transient login.
3. Update Hyperdrive's origin login, preserving its TLS configuration and disabling
   query caching. Update the exact SSM parameters. External changes to a parameter
   or an unexpected Hyperdrive/Lambda target stop the rotation.
4. Refresh Lambda with its worker parameter and a generation marker. This starts
   new execution environments rather than relying on a warm container to reload SSM.
5. Run smoke, logical backup/restore and read-only demo audit on canonical main.
   Verify successful runs with the exact rotation identifier and source SHA.
6. Wait at least the Lambda timeout plus one minute after configuration refresh.
   Existing invocations can reconnect with cached old credentials until then.
7. Verify privileges/readiness again. Refuse to retire a role with an active query.
   Disable old logins, clear their passwords and terminate only idle sessions.
   Verify that every old credential is rejected, then recheck the new logins.
8. Run smoke after retirement. Only after success discard the old recovery secrets
   from the current journal value. No LOGIN role is dropped while it owns objects.

A failure retains the encrypted journal. Running `rotate` resumes prepared,
promoted or retired stages; it does not silently generate another credential set.
The workflow does not print URLs, passwords, SQL/HTTP error bodies or SDK responses.
CLI inputs containing secrets use private temporary files removed after each call.
The one-command credential wrapper passes the URL only to its child process and
removes AWS/OIDC credentials. Mask directives are emitted only on GitHub Actions.

For a recovery requiring the previous configuration, run the workflow with
`operation=rollback` while the journal still contains its recovery entries. This
restores the prior logins, Hyperdrive and SSM values and refreshes Lambda; investigate
and resume rotation afterward. A completed rotation has cleared that recovery
material and must be recovered through the administrator connection. Old SSM
parameter versions remain subject to the same exact-parameter IAM permissions;
retired database passwords no longer authenticate.

The administrative `neondb_owner` credential remains a manually managed break-glass
secret in `/videoq/security/prod/db-admin`, outside the automatic service-login
rotation. Only the dedicated maintenance role and administrators may read it.
Do not copy it into application parameters or GitHub. Its emergency reset and
recovery are separate administrative operations.

## Initial setup and validation

Use an administrator AWS session and install the separately locked operations tools
before reading credentials:

```bash
npm ci --ignore-scripts --prefix .github/operations-tools
python3 infra/scripts/setup_neon_access.py
node .github/scripts/neon-admin.cjs bootstrap
```

`bootstrap` installs scoped roles/views/functions and initializes new operations
parameters. It does not change Hyperdrive or disable current application logins.
The worker parameter is independent of the API parameter. Grant Lambda permission
to read it before changing DB_PARAM_NAME; after a real processing smoke succeeds,
remove Lambda permission to read `/videoq/prod/db`. Keep Terraform aligned with the
worker parameter and preserve the maintenance-owned credential generation marker.

After merging the workflows, run `Maintain Neon Credentials` with `operation=rotate`
and verify the post-retirement smoke, then remove the legacy shared GitHub OIDC
role and its Environment ARN secret. Confirm that each purpose role denies other
parameters and that runtime roles cannot create objects. The verifier's negative
checks treat missing tables/network failures as failures, not as permission proof.

## Connection-source restrictions

IP allowlisting is a separate rollout after checking the Neon plan and all egress
paths. Neon IP Allow requires the Scale plan. Hyperdrive uses shared Cloudflare IP
ranges, not a unique source IP for this account. The current Lambda has no VPC,
and standard GitHub-hosted runners do not provide a dedicated fixed egress IP.
Enabling an allowlist now would block valid production/migration connections.

Prepare fixed egress for Lambda and the production runners, include Hyperdrive,
backup/rotation and emergency administration, and price the Neon plan/networking
before requesting approval for paid changes. Test allowed and denied connections
before restricting the production branch. IP allowlisting supplements database
identity checks; shared Cloudflare ranges do not identify a particular tenant.
