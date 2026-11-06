# Moodle personal conversations

This unreleased increment adds saved AI conversations to the embedded tool and
the native Moodle assistant. Learners can page through their conversations and
messages, resume one, start a new one, download a conversation as NDJSON, or delete
one. Human course Q&A remains separate. This is one part of the full scope in
`moodle-feature-access.md`, and does not complete external personal-data requests.

## Identity and authorization

Every operation checks the current LTI registration/session, Moodle enrolment,
File/LTI activity access and `local/videoq:manageownhistory`. Missing permissions
deny saved-history access, while legacy chat remains compatible. The capability
has course context and defaults to the student, teacher, editingteacher and
manager archetypes. A teacher cannot select another learner's conversations.

The server derives a durable opaque subject key from the verified registration
ID and subject hash. It never accepts this identity, the owner account or the
course from browser input. Thread IDs use a separate LTI namespace, subject,
owner, course and conversation UUID. No VideoQ learner accounts are created;
the connected VideoQ owner remains the storage/data operator and can manage
stored answer logs. The interface explains that distinction.

`lti_chat_log_subjects` is written atomically with every new LTI answer log,
including chat without a saved conversation. A failed attribution write rolls
back the log. `lti_conversation_scopes` records the verified subject and resource
scope of the model memory. Conversation turns, log, attribution and committed
checkpoint reference are committed together. Failed model attempts never become
committed conversation turns.

All reads and resumes require the saved resource set to be a subset of the
current permitted resources, intersected with current VideoQ ownership and course
membership. Restricting a lesson hides the entire affected conversation, including
its title, transcript and model memory. A successful later answer can widen its
recorded resource scope. Backend membership checks use transaction locks; detail
reads hold the conversation stable against concurrent commits. A learner may
still delete their own known conversation UUID after its resource set shrinks,
provided current course access and the history capability remain valid.

## Protocol and interface

`POST /api/lti/conversations` accepts strict `list`, `get`, `export` and `delete`
actions. Requests are bounded to 8 KiB, list pages to 50 conversations and detail
pages to 100 turns. Each page is independently authorized. Responses omit owner
IDs, raw log IDs and model checkpoints; `get` supplies only session-bound opaque
feedback references. Export omits feedback credentials as well.

The client downloads all pages of the selected committed transcript, with one
metadata line followed by chronological question/answer/source/feedback records.
It is a conversation export, not a full personal-data export. Internal retrieval
contexts, model checkpoints, Q&A posts/votes and older unassigned logs are outside
this download. Concurrent deletion can interrupt a download; retry after the
conversation is stable.

Saved-conversation requests send the single current question and a conversation
UUID. Model memory is loaded on the server, never supplied by a browser history
array. Playback context may inform generation; stored questions retain the
learner's original text. Starting a new conversation clears the displayed
transcript and selects a new UUID. The earlier session-scoped recent-question
view remains available when present; it does not retroactively migrate old logs.

The Moodle panel opens the existing authenticated LTI iframe without reloading or
moving it. The Q&A and personal-history panels are mutually exclusive. Switching
conversations replaces the native chat transcript through the existing
origin/source/channel-checked bridge. Bearer and feedback credentials stay in
the tool frame. Authorization failure clears saved-history UI and model-thread
selection. Previously downloaded content cannot be recalled.

## Deletion and retention

Explicit deletion removes the selected conversation, its linked answer logs,
subject mappings, turns and checkpoint payloads in one transaction. An active
answer lease prevents deletion until the answer finishes. Deleting a different
subject's UUID does not affect their data. There is no delete-all control yet.

Existing conversation expiry is thirty days of inactivity; each successful
answer extends it. The existing pruning job now also deletes attributed Moodle
logs associated with expired conversations. Attributed logs without an active
saved conversation expire after thirty days from creation. An older turn in a
still-active conversation remains until the conversation expires or is deleted.
These guarantees depend on deployment of migration 0052 and regular execution
of the existing pruning scheduler; they are not a hard wall-clock removal SLA.
Native VideoQ answer-log retention is unchanged. Backups, operational logs and
external AI-provider records need their own operator policies.

Earlier durable logs have no reconstructible Moodle-subject mapping. Do not
infer ownership from text, launch roles or the connected owner's user ID. The
short-lived recent-history credential is not durable attribution. Complete
legacy handling, all-person-data export/reset, Q&A erasure preserving peer
replies, privacy-officer authorization and Moodle Privacy API integration remain
open. Moodle's current callbacks still require external operator handling.

## Verification

On 2026-11-06, 25 real PostgreSQL tests passed across native/LTI conversations
and the complete empty/populated migration chain. These cover two-subject
isolation, resource narrowing, attribution rollback, stale backend membership,
restricted production API-role access, expiry cleanup and native regressions.
Migration provenance verifies 53 journal entries. The LMS synchronization suite
also passed 34 PostgreSQL tests.

Focused LTI/service tests passed 67 cases. Eight existing browser regressions and
two new browser scenarios passed. New scenarios exercise the actual companion
scripts, delayed initialization, native transcript replacement without iframe
reload, list/message pagination, a 142-turn download, delete confirmation,
permission revocation and narrow screens. The normal API suite passed 1,270
tests (721 environment-dependent cases skipped); the Workers suite passed 55.
API type checking, changed-file ESLint, Node build and official companion coding
checks passed. Installed Moodle 5.1 PostgreSQL/MySQL lifecycle tests each passed
14 reports with zero candidate developer diagnostics, including capability
defaults, course-local revocation/restoration, upgrade/reinstall and preservation
of Moodle source materials.

Browser HTTP responses and AI are fixtures. Complete live acceptance with Moodle,
VideoQ and AI, coordinated backend/companion deployment, and full CI and live
interoperability still require their own evidence before release.
