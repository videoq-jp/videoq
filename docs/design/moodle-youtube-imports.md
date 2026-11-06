# Moodle YouTube sources: implementation plan

Status: design only. Neither the backend nor the companion currently accepts
YouTube source manifests. Existing File synchronization remains available. This
document defines the next increment of the full Moodle feature-access objective;
direct-to-VideoQ uploads and broader owner/admin acceptance remain separate work.

## Canonical source and authority

Use Moodle's standard URL activity as the canonical source. A teacher saves a
YouTube URL through the existing core activity editor, then explicitly enables
VideoQ synchronization. Do not introduce a second independent video library or
let a learner-supplied URL select a source.

Interactive enable/disable/retry must require both current
`local/videoq:managecontent` in the source's course and
`moodle/course:manageactivities` on that module. The source-management permission
fix applies this policy to the existing File path first. A module-specific
activity grant can suffice alongside the course content grant; a course-wide
activity grant must not be required for every individual source.

Every read checks active enrolment, course visibility, the URL activity's current
availability and `mod/url:view`, the companion LTI activity and `mod/lti:view`,
current source generation, installation ownership and VideoQ course membership.
Instructor launch claims do not authorize management. Core activity editing,
course order and deletion remain authoritative. Legacy manually configured File
associations must retain their original interpretation.

## Identity and persistence

Extract one video ID from an allowlisted YouTube host and supported URL path.
Reject credentials, unsupported schemes, ports, malformed IDs, playlists without
a single video, lookalike hosts and ambiguous duplicate video parameters. Do not
fetch the submitted URL or follow redirects. Construct the worker's provider URL
from the validated ID; browser queries, fragments and Moodle URL parameters must
not become provider commands or arbitrary server destinations.

Proposed manifest: optional `kind: "youtube"` plus `youtubeVideoId`, without a
`file` field. Preserve existing File canonical JSON and manifest hashes exactly.
Keep a durable source kind and validated ID in both bindings, including disabled
and deleted bindings. Missing or newly invalid URL content must produce a
tombstone of the existing kind rather than silently becoming a File or losing
the remote identity. Add generated migrations with empty/populated database tests.

Create a separate Moodle-managed VideoQ video for each canonical source, even if
another course or native owner video uses the same YouTube ID. Reuse the existing
native YouTube feature policy and durable transcription outbox conventions.
Provider/queue calls occur after commit. Apply owner and worker quota checks at
the same stages as the native import; do not invent a zero-byte quota exemption.

## Synchronization and revocation

Source URL changes invalidate old generations immediately through the source
update observer. Synchronization replaces the managed video when the validated
provider ID changes and removes old course membership before admitting the new
source. Title/order/visibility changes follow Moodle. Hiding and explicitly
disabling remain distinct; hiding can preserve a teacher's core hidden-view
rights but never grant a learner access.

Repeated manifests and retries must not duplicate videos or jobs. Existing job
leases and usage receipts remain authoritative. Deleted or replaced source IDs
must not be revived by a delayed worker. Reuse owned cleanup and storage accounting
without deleting a video referenced by unrelated sources. No mocked readiness or
database status edit can substitute for an actual completed processing job.

Backups carry only portable source role/kind and explicit opt-in. Restore uses
the destination course, connection and current restoring user's authority; it
does not copy backend IDs, credentials, private history or an old generation.
Test activity duplication, partial/full restore, imported courses, recycle-bin
restore, invalid URL edits, companion repair and deletion.

## Compatibility

Negotiate YouTube support explicitly before enabling the source or emitting its
manifest. Add a request opt-in and backend capability rather than widening an old
strict response unconditionally. Old callers must retain File/course-entry
responses. New code must fail closed when support is absent or discovery fails.

Test both upgrade orders and downgrade behavior against actual old validators.
Existing managed/native-access guards must still deny direct access to a YouTube
video after rollback. Do not assume an older backend can process new tombstones:
retain the compatible disable/cleanup path and document the required coordinated
rollback before releasing either component.

## Native playback and privacy

Add a player adapter for YouTube with current time, duration, pause and citation
seek, preserving the private VideoQ iframe's existing origin/source/channel
checks. Only a server-validated provider ID enters the player catalog. The
YouTube iframe receives no LTI bearer, Moodle access proof, session token or chat
text. The existing File player remains supported. Destroy the old player on
source change; a late ready/error event must not act on the newly selected video.

The official [IFrame API](https://developers.google.com/youtube/iframe_api_reference)
documents playback/time/seek controls. Its [player parameter reference](https://developers.google.com/youtube/player_parameters)
describes JavaScript API enablement and origin binding. Use those interfaces and
meet the documented 200 by 200 pixel minimum on narrow screens. Test an
unavailable, private or embedding-disabled video without treating it as a File
download. Browser playback requires access to YouTube, separate from local AI.

Declare this external browser connection and provider processing in Moodle
privacy metadata and setup/operations documentation. Do not describe a particular
embedding host as eliminating all provider data collection. Verify the site's
actual CSP/referrer behavior and provider errors before selecting the final host.

## Acceptance gates

1. PHP-only source parsing and direct-action contracts; no new Node/Python
   dependency in Moodle runtime, tooling or CI.
2. Installed Moodle PostgreSQL/MySQL with real URL activities, separate teacher
   and learner roles, activity-specific rights, permission revocation, current
   generations, backup/restore and stale-work cancellation.
3. Backend manifest, migrations and restricted runtime/worker role checks:
   owner isolation, feature disabled, old peers, idempotency, quotas, replacements,
   outbox durability, delayed workers and deletion.
4. Native and embedded browser behavior: source switch, timestamp/citation seek,
   390 pixel viewport, provider failure, forged messages and credential isolation.
5. An owned provider fixture with real transcription/indexing and course AI
   citation playback. Synthetic transport/authorization fixtures establish only
   their stated contracts. This final gate is still open.

Marketplace classification MMS-433 does not block implementation. Plugin
distribution stays free; optional cloud billing remains in the existing VideoQ
Stripe flow. This plan authorizes no Marketplace replacement, merge or release.
