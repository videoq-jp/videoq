# Moodle course authority across VideoQ entry points

This unreleased increment closes native VideoQ access paths around automatically
Moodle-managed courses before delegated teacher content management is added.
The complete objective remains in `moodle-feature-access.md`; this is not full
Moodle feature parity or a deployment record.

## Persistent source policy

Migration 0053 adds `videos.managed_by_lms` and
`video_courses.native_access_disabled`. New synchronized videos retain their
Moodle provenance even after an installation or mapping is removed. New
synchronized courses set both the existing `managed_by_lms` flag and the new
native-access flag. Reconciliation repairs old source flags even when the
manifest generation has not changed.

The flags have different purposes. `managed_by_lms` on a course identifies its
canonical Moodle lifecycle. `native_access_disabled` also protects an older
independent course that contains or previously referenced Moodle material. That
course remains independently owned: its owner may edit/delete it and remove old
members or source associations, but those operations do not reopen external
access to its remaining conversation history or discussion.

Custom data migration 0054 backfills provenance from owned installation
resources and existing Moodle-managed course members. A mismatched installation
cannot relabel another account's video. It closes native access for managed
courses and courses with recoverable protected-video references in current
membership, structured answer citations, saved conversation turns, or Q&A's
retained original source ID. It does not infer provenance from question text.
Repeated execution is idempotent.

## Access boundaries

The central native course predicate denies external access if either course
flag is set or a current member video has Moodle provenance. All of the
following use it:

- Native member course lists, counts and details; public course details.
- Native/member and public AI chat setup, and the course gate before saved
  conversation listing, reading or deletion.
- Direct media requests, including both `share_slug` and `share_token`; a
  rejected share is denied before object storage or signed redirects are used.
- Public-share feedback and share existence probes.
- Invitation creation, public preview, acceptance including accepted-token
  replays, resend and the final authorization before queued email delivery.
- Native and public Q&A, including older independent courses with protected
  history after the original source membership is gone.

Independently authenticated VideoQ account owners retain operator reads, media
access, feedback and data-management authority. A native membership or possession
of an older link does not convey that authority. Verified LTI requests continue
through their existing fresh Moodle enrolment, activity and capability checks;
the native predicate does not replace or widen those grants.

Native writes cannot change Moodle-managed course metadata, delete its course,
reorder its videos or add/remove its video membership. Moodle is canonical for
that lifecycle. An LMS video cannot be attached to another native course, in
either a single or bulk request. Removing a legacy association from an
independent course is allowed; its native-access flag persists. Share revocation,
invitation revocation and removal/leave of old native memberships remain available
for cleanup and do not modify Moodle enrolment.

## Release and remaining scope

Deploy this backend together with migrations 0053/0054. Stop/drain older API and
materials-sync writers during cutover, run the migrations and backfill, switch
all affected readers/writers, and then resume service. An older backend does not
enforce these predicates and does not mark new videos. Do not claim a secure
rolling mixed-version window. Preserve a normal backup and rehearse the actual
deployment separately; no production data is changed by the development tests.

Backfill can use only surviving records. A source deleted before attribution was
retained, an unrecorded past membership, or uncited internal retrieval cannot
always be reconstructed. Existing unknown history still requires the external
data operator's legacy-data review/retention process. Already downloaded media,
answers and previously issued object URLs cannot be recalled by this API change.

The native management UI does not yet provide a Moodle handoff for every blocked
write. Teacher title/description/transcript editing, retry/reindex/deletion with
source rules, course ordering, tags, imports/uploads, empty-course entry,
analytics, complete privacy requests and independently authenticated
owner/billing/admin navigation remain required. Neither source authority nor
green API tests alone complete those functions.

## Verification

The dedicated PostgreSQL authority suite uses the complete real migration chain.
It covers source backfill and account isolation, native totals/details/media,
old share links and feedback, accepted invitation replays and queued delivery
without contacting mail, native fan-out, canonical course mutations, source
detachment/disconnection and history-only references in answers, saved turns and
Q&A. The corresponding migration tests exercise empty and populated databases.
Existing sparse native fixtures add the new false-default columns without
changing their assertions; they continue to exercise independent VideoQ behavior.

On 2026-11-06, the full API suite with PostgreSQL and LMS fixtures passed 1,931
tests (73 environment-dependent cases skipped) with four local workers. The
dedicated authority/full-chain run passed 14 tests; the Workers suite passed 55.
API type checking, changed-file ESLint, Node build, Drizzle checks and provenance
verification of all 55 migration entries passed. An unrelated authentication
migration test hit its existing five-second timeout in the initial unrestricted
parallel run; it passed alone and in the full bounded-parallel rerun. Its timeout
and assertions were not relaxed.

All tests use synthetic disposable data. Full live Moodle + VideoQ + AI
interoperability, coordinated release, custom roles/enrolment suspension and the
rest of the feature inventory still need their own evidence.
