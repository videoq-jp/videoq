# Moodle learning integration: scope and acceptance

This integration brings the VideoQ functions needed for teaching and learning
into Moodle. It does not reproduce the whole standalone VideoQ product. The
scope follows the clarified delivery request: sufficient course learning,
teacher material management, connection configuration, permissions and privacy.
New sharing UI, billing UI and global VideoQ user administration are not part of
this Moodle delivery.

## Roles and responsibilities

- Learners view course material, ask AI questions, follow citations, read
  transcripts, manage their own conversation history and participate in Q&A.
- Teachers opt materials in, monitor processing, retry failures, edit derived
  descriptions/transcripts, manage course tags and Q&A, and read course reports.
- Moodle administrators configure the connection, assign capabilities and use
  Moodle's standard privacy-request and approval workflows.
- Moodle core owns course creation, enrolments, activity editing/order, source
  files, visibility, conditional availability and deletion. The integration links
  to those authorized core workflows instead of creating parallel controls.
- Existing standalone VideoQ account, billing, global-library and system-admin
  functions remain in VideoQ. An operational handoff uses independent VideoQ
  authentication; a Moodle role never grants those privileges.

## Authorization model

Every course operation checks current Moodle enrolment, activity visibility,
availability and capabilities server to server. Launch-time Instructor or
Administrator claims do not authorize writes. Permission-service failure denies
access. Current Moodle resources are intersected with the registered binding,
source generation, VideoQ course membership and connected owner.

Learners use a pseudonymous identity scoped to platform/client/deployment/subject;
they do not need a separate VideoQ account. Own history and another person's data
have different authority. Teachers receive no general access to raw private AI
conversations. Native VideoQ shares or invitations cannot bypass a Moodle-managed
material's current access checks. Changes take effect on the next request,
including subsequent pages; already delivered content cannot be recalled.

## Implementation and evidence

“Implemented” describes the paired feature sources, not a deployed release.
The backend parent is `388e666b` with companion `20ea7741`. Its actual
[Moodle/local-CPU CI42362389689](https://github.com/videoq-jp/videoq/actions/runs/42362389689)
passes all 14 learning/teacher phases, 115 installed/network checks and retained
mobile presentation without developer/header warnings. This evidence uses
Moodle File media and actual local inference; it is not a hosted-provider test.

| Function | Implementation entry point | Acceptance state |
| --- | --- | --- |
| Empty-course entry and material selection | Companion course entry/catalog and backend LMS course bindings | Implemented; installed/owned-site empty-course, role and entry lifecycle checks exist |
| Native video, AI questions, citations and feedback | Companion player/chat; `/api/lti/messages/stream`, protected media/feedback | Actual File/local-CPU journey passes |
| Transcript paging, refresh and cited seek | Companion transcript panel; `/api/lti/transcript` | Actual reading/refresh/seek passes |
| Own conversation list, download, resume and deletion | Companion history panel; `/api/lti/conversations` | Nonempty history, cross-user denial and own model-memory erasure pass |
| Course Q&A, replies, votes and moderation | Companion Q&A panel; `/api/lti/qa` | Learner/teacher operations, cross-author denial and current-source/enrolment checks pass |
| Moodle File upload, title/file editing, order and deletion | Companion catalog links to the existing Moodle core editors | Implemented; opt-in, actual File transfer/processing and source visibility are verified; complete replacement/deletion/retry sequence still needs its targeted check |
| Optional YouTube URL source | Existing Moodle URL activity, companion source negotiation and native VideoQ cloud provider policy | Implemented where the backend advertises support; on-prem denial retained; actual hosted-provider acceptance is separate |
| Opt-in, disable, processing state and synchronization retry | Companion `manage.php` / `synchronizer` | Implemented with module/course capability and sesskey checks; installed/source contracts exist; failed-processing recovery still needs its targeted end-to-end check |
| Derived description/SRT editing, reindex and retry | Private tool-frame editor; `/api/lti/management` | Description edits, reindex, confirmed clear and original-ASR restoration pass; supported retry reuses job identity/usage receipts |
| Course tags/filtering | Companion tag panel; `/api/lti/tags` | CRUD, assignment/filtering and learner mutation denial pass |
| Usage reports and CSV | Companion report panel; `/api/lti/reports` | Positive counts/CSV, same-session capability revocation and post-history-delete zero counts pass |
| Connection and current permissions | Moodle connection page, pairing/material service and fresh course access | Actual pairing, normal roles, source/enrolment/capability changes and isolation pass |
| Core-approved subject export/delete | Companion Privacy API; `/api/lms/privacy` | Implemented; actual 17-phase core workflow is still under acceptance |

The first core-privacy run at `447eeb31` completes the original 14 phases and a
second real conversation with nonempty official model stores, then stops during
core export because the **test fixture** compares Moodle's TEXT comments column
through ordinary DML conditions. The correction scopes by numeric subject/type,
compares full comments in PHP through a closed recordset, and makes fixture
cleanup independent of request discovery. Actual core export/deletion remains
unproven until the corrected run passes. Do not count this as missing learner or
teacher feature code, or claim the uncompleted privacy phases passed.

## Compatibility and remaining delivery checks

New backend access requests opt into extended permissions and management/source
metadata. Older callers retain their strict response shape. Missing permissions
never grant a new capability. Transcript responses contain only current material
identity, cues and bounded paging data; iframe credentials never cross the native
message bridge.

The remaining necessary work is to assess the corrected core-privacy run, finish
targeted material replacement/deletion/failed-retry checks, and review the paired
backend/companion changes for coordinated release. Confirm the supported cloud
source path when delivering that edition. Existing per-feature design documents
contain historical, broader inventories; those are not a requirement to copy
standalone billing, public sharing or global user administration into Moodle.
The separate experimental worker-role/infrastructure work is preserved for its
own review and is not automatically a prerequisite for this scope.

Marketplace classification MMS-433 and listing publication remain separate from
implementation readiness. No production deployment or publication is implied by
source changes or test results.
