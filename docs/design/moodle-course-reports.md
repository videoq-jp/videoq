# Moodle course usage reports

Unreleased, stacked on the course catalog and restricted-worker verification.
This provides UTC daily AI question/feedback counts and aggregate CSV. It never
returns question/answer text, retrieved contexts, learner identities or raw chat
history. The full objective remains tracked in `moodle-feature-access.md`.

## Authorization and coverage

The companion adds `local/videoq:viewreports`: course-context read access with
`RISK_PERSONAL`. Teacher, editingteacher and manager archetypes receive it by
default; students and guests do not. Course overrides work independently of
content editing and Q&A instructor status. Launch-time role claims grant nothing.

Every request freshly checks Moodle permissions, enrolment, activity access and
visibility. The API intersects that scope with the installation, owner, course
membership, enabled resource generation and completed processing state. It locks
and revalidates the stored LTI session and database bindings in the transaction.
Missing capabilities, permission-service failure and expired sessions deny access.

New answers acquire installation/context provenance only from verified stored
database-backed LTI sessions. Owner/course matches cannot establish provenance:
historical records stay unassigned and are excluded without guessing/backfill.
Each counted answer's entire original resource scope and every cited video must
remain readable by the current viewer. Native VideoQ and foreign installations
or contexts are excluded. This is a current-scope view: hiding or removing a
material can reduce counts for an earlier period, rather than a historical census.

`POST /api/lti/reports` accepts exactly
`{action:"summary",from:"YYYY-MM-DD",to:"YYYY-MM-DD"}`. Real calendar dates are
inclusive UTC dates with at most 366 days per request. Browser input cannot
select course, installation, owner, actor or resource IDs. The DTO contains only
period, question/good/bad/unrated totals, daily counts and a fixed coverage marker.
Responses are private/no-store; request bodies are limited to 8192 bytes. SQL
uses five-second statement and 500 ms lock timeouts.

## Audit, privacy and browser

A successful read inserts an audit receipt in the same transaction; failed audit
insertion denies the response. Receipts contain a random ID, installation/course/
context, session-derived pseudonymous actor key, dates, resource count, scope hash
and timestamp. They store no message or report contents.

Core-approved external privacy export advertises `report_accesses`; the companion
negotiates that collection before requesting it. Erasure targets only the approved
actor/installation/context and invalidates the subject's sessions, preserving
other actors and shared teaching material. Configured `auditRetentionDays` cleanup
removes expired read receipts in bounded batches, preserving the exact boundary.
Read receipts need no mutation replay barrier. Existing retention monitoring and
backup/provider/operator privacy requirements still apply; a hashed identifier
is not a legal anonymity guarantee.

Both standalone course entries and native report panels use the frame's available
space while open, with a return-to-questions control. Other assistant panels are
retained and become visible again when the report closes. Summary counts use a
compact label/value grid so mobile viewers do not need to scroll past other tools.
Independent assistant tools initialize concurrently; a slow personal-history
request cannot prevent reports or other tools from becoming available. Identical
in-flight material metadata requests share a single permission check, with no
cache once it finishes. Later reads and all protected operations reauthorize.
Unavailable report metadata hides reports without aborting the chat initializer.
The UI uses text nodes and clears previous results when loading or access is
revoked. Epoch invalidation discards late revoked responses. CSV reloads with
fresh authorization, exporting fixed date/count columns only. Native Moodle uses
the existing private LTI iframe; only source/origin/channel/video-bound open,
close and availability messages cross the bridge, with no report or credentials.
The UI explains UTC, current-scope and historical-provenance limits.

## Coordinated upgrade and verification

Drain old API/sync writers, apply generated migration
`0060_moodle_course_reports.sql` (61 journal entries), then reapply
`infra/sql/neon-security.sql` as migration administrator before starting the new
API/writers. This grants the new audit table to the restricted API role. The
companion is local 0.20.0 / 2026110703 with a no-DDL savepoint; ltisource is
unchanged. New authenticated requests explicitly send `includeReports:true`.
The companion removes that permission for old callers; old companions return no
positive capability and old backends announce no support. Either mixed pairing
keeps reporting unavailable. New API code still requires migration/grants first.

Verification covers real PostgreSQL provenance/scope/date/audit/privacy behavior,
actual producer/report/retention through a restricted API login, existing privacy
and migration regressions, and embedded/native browser fixtures including CSV,
revocation, malformed responses, private transport and a 390 px viewport. These
fixtures use synthetic answers and mocked browser transport, not real AI.
Installed PostgreSQL/MySQL capability lifecycles and full owned
Moodle/API/worker/AI acceptance remain separate release gates.
