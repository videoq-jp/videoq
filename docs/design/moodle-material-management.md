# Moodle material management

This branch adds delegated teacher edits, processing controls and the native and
embedded editor. This is unreleased work and does not complete the full Moodle
feature-access objective. Full live Moodle + VideoQ + AI acceptance remains open.

## Authority and source of truth

Moodle owns the activity title, file, visibility, opt-in and deletion. The native
material list links each authorized source to core activity editing, its existing
VideoQ synchronization page and the course's activity controls (including core
deletion). These flows keep Moodle's login, module permissions, sesskeys and core
deletion lifecycle. No new API lets a delegated teacher delete another account's
video independently of its Moodle source. Full live source-edit/delete propagation
and processing-retry acceptance remain release gates.

`POST /api/lti/management` handles only derived description/SRT edits, reindexing
and eligible processing retries. Every operation rechecks the current Moodle
permission response, per-resource management metadata, binding, source generation,
VideoQ owner, enabled installation, managed course/video and current membership.
Instructor/Administrator launch claims grant no write permission. Management of a
video referenced by another course or resource is refused rather than changing
content for an unrelated audience.

Processing/error materials have a separate management scope. Only completed,
currently allowed materials enter the learner, transcript, Q&A and AI scope.
Source generations in extended access responses must match current DB bindings.
Older responses retain learning compatibility but grant no new management right.
The companion strips extended resource metadata and processing-only materials
unless the backend explicitly requests `includeContentManagement: true`.

## Writes and background work

The API accepts strict, bounded inputs and returns bounded editor fields plus a
revision and safe job state. It returns no owner/account IDs, storage keys,
credentials, provider errors, actor keys or internal task IDs. The revision binds
the source generation and current editable state. Stale drafts fail with 409.

Each mutation has a UUID operation ID. Content, an identifier-only audit receipt
and the durable outbox task commit together. Replay with the same actor, resource
and request does not duplicate work. An operation ID reused with a different
actor/resource/request is refused. No provider call runs inside the transaction.
Queue dispatch occurs after commit; dispatch failure leaves the durable intent
available to the existing task processor.

SRT changes immediately set the video to `indexing`, excluding it from learning
until indexing succeeds. Mutations take the same nonblocking advisory writer
locks as the Python indexer. Completion also checks the exact transcript, file,
owner and indexing status, so an intervening source change cannot be falsely
marked complete. Unchanged transcripts do not schedule indexing.

An explicit manual clear sets `allow_empty: true` on the indexing job. The worker
validates this as a boolean only for that job type, clears both embedding profiles
in one transaction and checks the current owner/transcript before deleting.
Automatic empty/invalid transcription continues to fail; the flag does not permit
invalid nonempty SRT. A failure clearing either profile preserves both profiles.

Transcription retries reuse the original supported message and job identity to
preserve worker leases and usage receipts. Already-completed receipts and legacy
or unsupported messages cannot be retried this way: they require the future
Moodle synchronization retry flow. This also avoids moving an errored material
to `pending` for a job the worker would acknowledge without executing.

## Persistence and release gates

Drizzle-generated migration 0055 adds `lti_material_operations` and an expression
index for per-video job lookup. Receipts contain resource/course/video IDs,
generation, pseudonymous actor key, action, hashes, optional task ID and time;
they contain no edited content. Resource/course deletion cascades receipt
deletion; video/task deletion clears those references. No timed receipt retention
or learner/privacy-officer export/delete flow is implemented in this increment.
Those workflows must include this metadata in the remaining privacy work. The
companion Privacy API declares teacher content edits and pseudonymous audit
receipts as data stored externally by VideoQ.

Deploy the compatible worker before enabling API writes that produce
`allow_empty`; older workers reject this new field. Apply migration/grants and
the authority branch's coordinated cutover requirements before the companion
editor is released. The current Marketplace sources and ZIPs are unaffected.

The editor reuses the existing private iframe, switches with Q&A and personal
history, and preserves drafts across panel switches, conflicts and permission
revocation. Revoked drafts remain available for copying in read-only controls;
the frame sends only availability/draft booleans across the bridge. Exact failed
requests retain their operation identity for retry after a lost response.
Refreshing/switching material requires confirmation before discarding a draft.
Explicit clear, reindex and retry also require an in-frame confirmation.

The composer tracks learning availability separately from answer-generation
activity. Processing-only teachers can open management without history access;
bounded five-second polling (at most 60 attempts before manual refresh) restores
learning after a material becomes ready. Pending video playheads are never added
to AI questions. The poll updates processing state without replacing draft text.

Remaining work includes restricted production-role/Workers runtime verification,
full isolated Moodle + VideoQ + AI checks, source lifecycle/retry acceptance and
the full external privacy workflow. The wider inventory, including imports,
tags, reporting and independently authenticated owner operations, remains in
`moodle-feature-access.md`.
