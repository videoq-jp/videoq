# Moodle course tags and filtering

The course-tag increment adds a dedicated tag vocabulary for each managed Moodle
course. The connected owner's global `tags` and `video_tags` are unchanged and
remain reachable through independently authenticated account management. A
teacher's course capability never grants global tag rename/deletion or access to
another course's vocabulary.

## Current authority

`POST /api/lti/tags` uses the existing LTI credential, origin checks, throttling
and fresh Moodle course access on every request. The browser supplies an action,
tag IDs and optional material ID, never an owner, course, actor, generation or
role. Static/unverified registrations cannot use it. A revoked enrolment or an
unavailable permission service denies access.

Learners receive only names, colors and assignments attached to their currently
readable materials. The response never includes hidden materials' IDs/counts or
tags used only by them. Unused vocabulary is visible only with course content
management authority. Processing-only material metadata stays in the separate
management scope; it does not enter transcript, Q&A or AI learning scope.

Creating vocabulary requires the current `local/videoq:managecontent` capability.
Assignment changes also require that exact material's current module management
grant, source generation, enabled binding, owner and course membership. Renaming
or deleting a tag checks those grants for **every** assigned material. Partial
managers can attach/detach vocabulary on their own material without renaming or
deleting a tag shared with materials they cannot manage. All displayed counts
refer only to the caller's allowed materials.

## Persistence and concurrent writes

Generated migration 0056 adds `lti_course_tags`, `lti_course_video_tags` and
`lti_course_tag_operations`. Course deletion cascades vocabulary, assignments and
receipts; deleting a video removes its assignments. A source replacement starts
without the old video's assignments. Tag metadata stays with the course.
Moving a preserved source to another course removes its old course assignments;
ordinary resync and temporary disable/re-enable preserve same-course assignments.
The service rechecks current enabled bindings, owner, membership, processing
status and per-resource management generation inside the database transaction,
covering a source update between the Moodle permission fetch and database access.

Tag rows use optimistic UUID revisions; assignment sets use a hash of that
course, material and current tag IDs. Stale forms fail with 409 and do not
overwrite another teacher's changes. Account/installation locks follow the
synchronizer's existing lock order, serializing vocabulary changes and source
updates. Each mutation has a UUID idempotency receipt bound to actor, course and
request hash. A lost response can be replayed without duplicating a creation or
write. Reusing the ID for a different actor/course/request fails.

Names are trimmed, contain at most 50 characters and exclude control characters;
colors use the existing tag-color vocabulary. Each course has at most 200 tags.
Requests have strict bounded schemas and lists are bounded by the existing
1000-resource access response. No receipt stores tag text, credentials or an
external account identity. The restricted API deployment profile explicitly
grants the three new runtime tables; runtime DDL remains prohibited.

## Native and embedded interface

The existing private LTI frame renders the tag editor and filtered material list.
Teachers can create, rename, recolor, delete and assign tags; learners can search
titles/filter by tag or untagged materials, open a permitted source and read its
paged transcript when separately allowed. Untrusted names, titles and transcripts
are rendered as text. Destructive deletion and draft discarding require explicit
confirmation. Failed/conflicted requests keep the draft; uncertain retries keep
the operation ID. A revoked draft becomes read only and remains selectable.

The companion's native control reuses the same frame and shared tool-panel
switching mechanism. Origin, window source, channel and launch identity are
checked; tag text, assignments, operation IDs, actor IDs and credentials do not
cross its message bridge. Older backends do not advertise the tag feature, so the
new native control stays hidden. Older companions can use the embedded control.
The local plugin is unreleased 0.16.0 / 2026110609; the launch companion is unchanged.

## Verification and remaining scope

The final focused regression run passes 189 tests across 16 LTI/LMS files, including
real PostgreSQL isolation, hidden-resource filtering, partial management, stale
forms, replay, cleanup, strict routes and the actual restricted production-role
profile. Native Chromium runs the new interface with the real companion scripts
using mocked HTTP, alongside the existing teacher editor. The companion's 13 PHP
contract suites and official Moodle coding check pass with zero errors/warnings.
API type checks, changed-source ESLint, migration verification and Node builds pass.

In the isolated real Moodle 5.1 environment, migration 0056 runs as the existing
schema owner and the API uses its deployed restricted database role. Verified-TLS
HTTP requests complete a normal Moodle-signed LTI launch and tag create,
assignment, name/color update, replay and deletion. Stale revisions, forged course
selection and foreign origins are refused. Removing the teacher's current Moodle
capability denies the next request using the same LTI credential; restoring it
restores access. The test removes its role override and tag afterwards.

A native macOS Chromium journey through those services also passes without HTTP
mocks: ordinary Moodle teacher login, private-frame LTI startup, native tag-panel
opening, create/assign/rename/recolor, confirmed deletion and return to native
questions. At 390 × 844 the frame has no horizontal overflow; screenshots are
visually checked. Only the ephemeral local browser certificate is accepted by
the browser; the separate PHP/API HTTP proof verifies the lab CA. This browser
test uses the backend's web tooling; the companion remains PHP-only. Source
generation 4 and pending processing stay unchanged, and no AI attempt is made.

The schema-isolated synchronization fixture now applies the actual migration
0056 as well. Early fixture/timeout failures are retained as evidence; the final
189-test run uses one local worker with unchanged test/hook limits and all passes.

These checks do not establish all live Moodle/VideoQ/AI behavior. Canonical Moodle
imports/course ordering/management, empty-course entry, aggregate reporting,
independent cloud/admin acceptance and the complete external privacy lifecycle
remain in `moodle-feature-access.md`. The Privacy API declares tag metadata and
pseudonymous operation receipts externally; learner/privacy-officer export and
deletion and audit retention remain unfinished. Deploy the compatible migration,
grants and API before enabling the companion. Published Marketplace sources/ZIPs,
Stripe and licenses are unchanged.
