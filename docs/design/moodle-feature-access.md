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

## Native implementation and evidence

The Moodle companion now owns all learning screens. The browser calls Moodle's
session-authenticated `core/ajax` function and same-origin answer stream. PHP
resolves the current user, course and capabilities and signs private requests to
`/api/lms/native`. VideoQ retains common AI, search, indexing, persistence and
erasure services. Neither visible VideoQ frames nor hidden authentication frames
are part of this transport. See [the native protocol](./moodle-native-ui.md).

Companion `b5af6b99` passes
[CI42403530839](https://github.com/videoq-jp/videoq-moodle/actions/runs/42403530839):
PHP checks, native-browser contracts and actual PostgreSQL/MySQL installation,
upgrade, capability, privacy and uninstall/reinstall checks. The native external
function is registered as login-required/AJAX-capable and removed on uninstall.
The browser contracts use actual Moodle templates with controlled API/model
substitutes. They do not prove actual native AI inference or subject erasure.

| Function | Native entry point | Evidence still required for this transport |
| --- | --- | --- |
| Empty-course entry and material selection | Moodle workspace/templates and course catalog | Real native course/role flow; controlled empty-course UI passes |
| Video, AI answers, citations and feedback | Moodle player/chat, PHP stream and native messages/feedback API | Actual File/local-CPU answer and citation/feedback journey |
| Transcript paging, refresh and seek | Moodle transcript panel and native transcript API | Actual reading/refresh/seek |
| Own conversation list, download, resume/delete | Moodle history panel and native conversations API | Actual nonempty history, cross-user denial and model-memory erasure |
| Course Q&A, replies, votes and moderation | Moodle Q&A panel and native Q&A API | Actual learner/teacher operations and current authority |
| Canonical upload, title/file editing, order/deletion | Existing Moodle core editors through catalog links | Existing source/recovery database evidence retained; real native integration |
| Optional YouTube URL source | Moodle URL activity and optional provider player | Current-grant/player contracts pass; actual hosted provider remains edition-specific |
| Opt-in, processing state and synchronization retry | Moodle manage/synchronizer and existing material services | Installed capability/lifecycle checks pass; existing focused recovery evidence retained |
| Derived description/SRT, reindex and retry | Moodle material form and native management API | Actual edits/indexing; controlled drafts/conflicts/uncertain retries pass |
| Course tags/filtering | Moodle tag panel and native tags API | Actual CRUD, assignment/filtering and learner denial |
| Usage reports/CSV | Moodle report panel and native reports API | Actual aggregates, CSV, capability revocation and post-erasure counts |
| Connection and current permissions | Existing pairing, Moodle capabilities and private native assertions | Installed roles/registry pass; actual PHP-to-VideoQ native authentication |
| Core-approved subject export/delete | Moodle Privacy API and existing LMS privacy services | Repeat standard approval, archive/model-store comparison, erasure and original-session denial |

The actual CPU/privacy acceptance keeps the established 17 workflows and now
uses Moodle endpoints and native controls. It additionally requires protocol 1,
no File-page iframe, no direct browser learning request to VideoQ/storage and no
browser Authorization header. Native completion remains unproven until this
paired real-service run passes; old iframe acceptance is a baseline only.

## Historical iframe baseline

Backend `38393b49` with companion runtime `20ea7741` passed all 17 phases in
[CI42381005443](https://github.com/videoq-jp/videoq/actions/runs/42381005443).
Evaluation package `fa22bd29` has the same runtime with privacy documentation
changes. That run used actual File/local-CPU inference, 115 installed/network
checks and retained mobile presentation without developer/header warnings.
It does not validate the replacement native transport.

That historical core-privacy journey creates a second actual AI conversation with nonempty
official model stores. The subject uses Moodle's standard export and deletion
forms, and a separate administrator approves each request. Pending requests
retain the original data; learners cannot approve requests and teachers cannot
download another learner's archive. The downloaded core archive matches the
subject conversation and all three model stores. Approved deletion erases the
subject's memory and revokes the existing session while retaining peer replies,
shared course materials and standalone owner content. Both retained speech
recognition results independently reassess to CER 0 for 45 reference characters.

The targeted synchronization and material-management PostgreSQL suites pass 68
checks. The added failed-File recovery check injects an error status after actual
HTTP upload/confirmation, then verifies a new generation, repeated requests,
retired upload/confirmation denial, durable processing tasks and current learning
availability. Queue delivery is omitted in these suites and model completion is
represented by a database status update. This is focused API/database evidence;
actual inference is established separately by the accepted File/local-CPU journey.

## Compatibility and remaining delivery checks

The new companion requires native learning protocol 1. Older browser-LTI clients
retain their existing response shapes and separate authentication path; native
credentials cannot authenticate through that path. Missing permissions deny
access. No VideoQ token, assertion or server-session identifier is sent to the
Moodle browser. Moodle capability refusals retain their authority status through
the gateway instead of appearing as transport success.

Deliver the paired backend and companion together after actual native acceptance
and source-pinned installer verification. Confirm the supported cloud source path
when delivering that edition. Historical broader feature inventories do not
require copying standalone billing, public sharing or global user administration
into Moodle. Separate experimental worker/infrastructure work remains outside
this delivery.

Marketplace classification MMS-433 and listing publication remain separate from
implementation readiness. No production deployment or publication is implied by
source changes or test results.
