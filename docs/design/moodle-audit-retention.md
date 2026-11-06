# Moodle personal audit retention

Unreleased, stacked on the approved external privacy implementation. This covers
teacher material/tag operation receipts, report access receipts and LTI moderation actor identifiers.
The full Moodle feature inventory and other data-retention requirements remain.

## Operator configuration

After the full migration chain (including generated schema migration 0057 and
custom data migration 0058 and report schema migration 0060), API grants and **all writers** are deployed, add an
integer `auditRetentionDays` from 1 through 3650 to the existing `LTI_CONFIG` JSON.
Omit it to disable automatic audit cleanup. There is no implicit default or new
secret/binding. Existing tool origin, registrations and privacy settings remain
necessary. Do not add this setting to an older API or during mixed-version
deployment. Complete migration and API drain/upgrade before enabling it.

This is a deployment operator setting. Moodle teacher/administrator status,
learner roles and browser input cannot change it. Individual core-approved
privacy requests do not require this automatic-retention opt-in.

## Removal and replay semantics

The existing daily retention scheduler removes material/tag receipt rows whose
creation time is strictly earlier than the maintenance clock minus the configured
number of 24-hour days. It also sets expired **LTI** moderation actor identifiers
to null, and removes expired report access receipts. Read receipts need no
mutation replay reservation. Native VideoQ moderation actors and shared event actions/structure are
unchanged. Q&A posts, replies, peer votes, shared videos/descriptions/transcripts,
tag vocabulary/assignments and queued processing work are preserved.

Removing a receipt must not make its operation UUID reusable. A separate permanent
reservation stores **one SHA-256 key only**, namespaced by operation kind and the
canonical random UUID. It has no actor, course, source, action, request hash,
contents or timestamp columns. The migration backfills old receipts; all new
writes reserve before checking their receipt. A recent identical request replays
normally. A retired UUID without its receipt returns 409 and requires starting a
new operation. No expired request silently repeats a content change or job.

Approved individual erasure also creates/preserves these minimal barriers while
removing the personal receipts. Reservations are not subject profiles or an
authentication mechanism. They persist across course/account deletion and are
not exported as attributable user records. A holder of an original UUID can
recognize its reservation; do not describe this as a legal anonymity guarantee.
Backups and operator/provider stores have their separate processes.

The guard row is locked in the mutation transaction. Cleanup locks available
guards before removing receipts, skips busy guards, and rolls back reservation
creation together with any failed removal. A failed mutation rolls back its new
reservation. Different operation kinds have separate namespaces. No provider
network request occurs while these locks are held.

## Bounded execution and monitoring

Each invocation processes batches of 500, at most 20 passes per collection, with
a 25-second admission budget, five-second SQL statement timeout and 500 ms lock
timeout. A transaction already started may finish after the admission budget.
Busy rows, remaining volume or that budget produce `backlog: true` and the
structured `lti_audit_retention_backlog` event, containing counts rather than
identifiers or record contents. Failures are reported through the existing
maintenance aggregate and do not cancel independent recovery tasks.

Cleanup is eventual and depends on scheduled maintenance; this is not a strict
wall-clock deletion SLA. Monitor backlog during initial adoption and high-volume
operation. Workers use the existing daily retention cron. In the on-prem API
runtime, `node dist/node.mjs retention` invokes that same retention path; the
`maintenance` command runs delivery recovery instead. Run further retention
invocations to drain a backlog and investigate repeated contention/failures.
No production cleanup is performed by this change's verification.

## Verification scope

Real PostgreSQL tests use full migrations and check boundaries, disabled/invalid
configuration, permanent replay refusal, corrected retries after rollback,
actual old-data backfill, contention, a 10,001-row backlog across invocations and
failure rollback. Shared content/native moderation preservation and approved
privacy erasure remain explicit assertions. The actual API security profile,
existing teacher/tag/sync/privacy suites and scheduler wiring are regression gates.

This completes neither the full UI privacy-request approval workflow nor Moodle
feature parity. Legacy unattributed logs, physically removed user IDs, backups,
provider storage and personal information embedded in shared content remain
operator work tracked in `moodle-privacy.md` and `moodle-feature-access.md`.
