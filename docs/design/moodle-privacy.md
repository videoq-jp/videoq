# Moodle approved external data requests

Unreleased; paired with `local_videoq` 0.17.0. This increment adds external
subject export/erasure to Moodle's core privacy workflow. Reporting, canonical
course/content management, production rollout and the remaining feature inventory
are separate gates. No existing Marketplace source or release is replaced.

## Authority and rollout

`POST /api/lms/privacy` accepts only a Moodle-platform RS256 assertion with
`typ=videoq-privacy+jwt`, the exact stored issuer/client/deployment, the canonical
API audience, a lifetime of at most 120 seconds and a single-use UUID nonce.
JWKS addresses come from the registered installation; JWT headers cannot select
a URL. Learner LTI sessions, launch roles, browser cookies, sync tokens and tool
assertions do not grant privacy authority. The Moodle provider has no public
signing endpoint and takes subjects/approved contexts from core callbacks.

Add `"privacyEnabled": true` to the existing `LTI_CONFIG` object only after the
paired release and all writer processes are upgraded. The default is off. Drain
old API writers first, run the normal expired-credential cleanup and allow old
recent-history caches (24-hour TTL) to expire. An active history cache without
subject attribution rejects privacy operations with `PRIVACY_UPGRADE_PENDING`.
Apply the existing complete migration chain and official checkpoint setup, and
the normal API security profile; no new database migration or secret is needed.
Do not enable during a mixed-version rollout. A failed/unavailable external
service fails the Moodle request rather than presenting an empty successful export.

Inactive installations and over-quota accounts retain this recovery path while
their stored registration and owner remain. Keep the platform signing key and
remote registration until outstanding requests are resolved. Moodle retains
public connection tuples after subsequent connections; it does not retain API
credentials for this purpose. A changed/cloned Moodle issuer cannot use the old
tuple. Uninstall removes that local history, so arrange outstanding external
requests before uninstalling or retiring the site.

## Scope and output

The backend derives opaque subject keys from the registered tuple and Moodle
user ID. It never creates a VideoQ user or impersonates the connected owner.
Fourteen collections cover attributed logs/retrieval evidence/evaluations,
saved conversations/turns, authored Q&A, votes, moderation, material/tag receipts,
recent history and all three official model-checkpoint tables. Authentication
credentials and provider error traces are not exported. Model bytes are base64
encoded; no reinterpretation or truncation is performed.

Each surviving course maps to its Moodle course context. Records without a
surviving mapping, or with a deleted local course, use the system context.
System approval covers those residual records, not all surviving courses.
Discovery scans all local user IDs in bounded batches, including deleted and
formerly enrolled users. Physically removed Moodle IDs cannot be reconstructed.

Export pagination is per fixed collection and natural key. One JSON record is
split into at most 65,536 Unicode-codepoint fragments, with offset, total and
SHA-256 revision checks. Changed records fail with 409 rather than combining
inconsistent fragments. The Moodle writer produces paged NDJSON for ordinary
records and numbered UTF-8 fragments plus a concatenation/checksum manifest for
records exceeding 4,194,304 characters. There is no global multi-request snapshot;
concurrent edits can require restarting an export.

## Erasure and concurrency

Within an owner-locked transaction, erase selected subject/course sessions and
feedback references, recent history, conversations, logs/evaluations, all model
memory and personal operation receipts. Session checks in data writers serialize
with erasure; a late answer cannot recreate logs, history or feedback references.
Conversation foreign keys reject late checkpoint writes after erasure.

Own Q&A text and author identity become tombstones. Peer replies, peer votes and
thread structure survive. Moderation events retain their action but lose the
requesting subject's actor identifier. Shared video files, transcripts,
descriptions, source bindings and tag vocabulary/assignments are retained. They
are shared course content and may require a separate operator/content review.

## Remaining operator and retention work

Legacy logs created before durable subject attribution cannot be safely assigned
by guessing question text or the connected owner. Historical backups, application
logs and AI-provider storage require the operator's separate process. Retain that
process and contacts in the site's data policy. This API is not a certification
that those other stores are erased. A lost/deleted remote installation or a
physically removed Moodle user ID also needs operator review.

Existing conversation/log expiry and temporary credential cleanup continue; they
require scheduled maintenance. Operator-configured, bounded automatic cleanup of material/tag receipts and LTI
moderation actor identifiers is implemented in the audit-retention branch; see
`moodle-audit-retention.md`. Minimal permanent replay barriers remain after receipt
removal. Do not describe this increment
as complete retention coverage or complete Moodle feature parity.

Verification includes real PostgreSQL full migrations/checkpoint setup, paired
PHP contracts and pinned Moodle Privacy API interfaces. Real Moodle acceptance
uses only owned synthetic fixtures, verified local TLS and the restricted API
database role. Production and actual model-provider erasure are not tested here.

On 2026-11-07, the owned real site at backend `0526839a` and companion
`2026110703` completed a populated export through Moodle's standard request form,
independent administrator approval, the exact official queued export task and
the subject's normal ZIP download. The same original request was resumed across
fresh browser sessions, without duplicate submissions. All 19 original report
access IDs were present, each scoped to Moodle course 4, and the original records
remained unchanged. An ordinary teacher could not open the approval screen and
another learner could not download the subject's archive. Actual platform-signed
discovery used verified TLS; unsigned external requests were rejected with 403.
The archive remains private. Temporary contact/mail settings were restored and
checked from a separate PHP process; no model or general cron was started.

This verifies populated report-receipt export through core approval, not complete
subject erasure, peer retention, all model-memory/provider/legacy stores or a
production rollout. Those remain separate requirements.
