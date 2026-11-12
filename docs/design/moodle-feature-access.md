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

The Moodle companion owns all learning screens. Browser actions use Moodle's
session-authenticated `core/ajax` function and same-origin answer stream. PHP
resolves current user/course/capabilities and signs private requests to
`/api/lms/native`. VideoQ retains shared AI, search, indexing, persistence and
erasure services. Presentation and hidden authentication frames are removed.
See [the native protocol](./moodle-native-ui.md).

Backend `3991046b` and companion `eb2cca35` (0.22.1 / 2026110802) pass the
[17-phase actual native job](https://github.com/videoq-jp/videoq/actions/runs/42425984474/job/128564274713).
It uses real Moodle PHP signatures, File export, local CPU speech recognition,
indexing, model inference and Moodle learner/teacher/privacy workflows. The
same source pair passes 115 installed authority/network checks. The tested
merge `cc861dd5` has exactly the same tracked tree as the backend revision.

Companion [CI42412736121](https://github.com/videoq-jp/videoq-moodle/actions/runs/42412736121)
passes PHP/tooling/native-browser contracts and actual PostgreSQL/MySQL
installation, upgrade, capability, privacy and uninstall/reinstall checks. The
native external function is registered as login-required/AJAX-capable and removed
on uninstall. Installed checks resolve real Moodle actors and empty courses,
render File/empty workspaces with Moodle's HTML renderer, and execute the complete
File PHP page. Course/login checks finish before theme initialization. Controlled
browser contracts additionally exercise drafts, conflicts, uncertain retries and
optional players; those substitutes are separate from actual model acceptance.

| Function | Native entry point | Verified evidence and scope |
| --- | --- | --- |
| Empty-course entry and material selection | Moodle workspace/templates and course catalog | Actual installed actor/empty-course rendering and controlled empty-course UI |
| Video, AI answers, citations and feedback | Moodle player/chat, PHP stream and native messages/feedback API | Actual File/local-CPU answer, citation seek, MP4 decode/range and feedback |
| Transcript paging, refresh and seek | Moodle transcript panel and native transcript API | Actual reading/refresh/seek |
| Own conversation list, download, resume/delete | Moodle history panel and native conversations API | Actual nonempty history/export/resume, cross-user denial and model-memory erasure |
| Course Q&A, replies, votes and moderation | Moodle Q&A panel and native Q&A API | Actual learner/teacher CRUD, votes, moderation and current source/enrolment authority |
| Canonical upload, title/file editing, order/deletion | Existing Moodle core editors through catalog links | Installed source/recovery checks and real native File integration; existing core editors are reused |
| Optional YouTube URL source | Moodle URL activity and optional provider player | Current-grant/player contracts; actual hosted provider remains edition-specific |
| Opt-in, processing state and synchronization retry | Moodle manage/synchronizer and material services | Actual opt-in/import/indexing, installed lifecycle checks and focused recovery tests |
| Derived description/SRT, reindex and retry | Moodle material form and native management API | Actual edits/reindex/clear/restore; controlled draft/conflict/uncertain-retry contracts |
| Course tags/filtering | Moodle tag panel and native tags API | Actual CRUD, assignment/filtering, learner denial and transcript access |
| Usage reports/CSV | Moodle report panel and native reports API | Actual UTC aggregates/CSV, capability revocation and post-erasure zero counts |
| Connection and current permissions | Pairing, Moodle capabilities and private native assertions | Actual owner pairing, teacher opt-in, PHP signatures, protocol 1 and owner-sentinel denial |
| Core-approved subject export/delete | Moodle Privacy API and LMS privacy services | Actual standard approval, archive/model-store match, erasure, peer retention and original-session refusal |

The native job completes all 17 workflows. Three native pages produce 163 Moodle
gateway requests, with zero direct browser learning requests to VideoQ/storage,
zero browser Authorization headers and no uninspected native request headers.
File pages have no presentation or hidden authentication iframe. The actual
390px Moodle screenshot is visually inspected. Both real answer streams deliver
text before done, retain citations, and finish without an error event.

A learner submits Moodle's normal subject export/deletion forms and a separate
administrator approves them. Pending requests retain data. The downloaded subject
archive matches its conversation and all three official model stores; teachers
cannot download it. Approved deletion removes the subject's AI memory and denies
both read and write with the exact original Moodle session, while preserving peer
replies, shared material/transcripts/vectors and the standalone owner sentinel.
Reports return to zero. Both retained recognition results have CER 0 for the
45-character reference. This fixture does not measure silence hallucinations.

The refusal probe snapshots only the original Moodle cookie, CSRF key and course
context in memory and replays them to the real login-required Moodle gateway.
This preserves the credential being tested when core/ajax's normal login
navigation would destroy an in-page observer. No replacement session or successful
response is fabricated. A fast Chromium check uses the pinned actual core/ajax
and jQuery client to verify navigation, cookie rotation, original-cookie replay
and rejection of unknown/HTML/redirect/transport failures as refusal evidence.

The standard installers match all 65 `local_videoq` and 6 `ltisource_videoq` committed
files at the exact accepted companion revision. Deliver the paired backend and
companion together; actual hosted-provider paths and Marketplace approval remain
separate delivery checks.

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
