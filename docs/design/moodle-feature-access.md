# Moodle feature access

The objective is to make all VideoQ functions reachable from Moodle with appropriate permissions. Marketplace classification (MMS-433) does not block this implementation. This document tracks the whole scope; the transcript reader is the first addition, not completion of the objective.

## Authorization model

- Moodle decides enrolment, activity visibility, availability conditions and course capabilities. Check these server to server for every course operation. A launch-time Instructor or Administrator claim is insufficient for writes or access to additional information.
- Intersect Moodle's allowed resources with the current registered bindings, the VideoQ course membership and the owning VideoQ account. A browser cannot select an account, deployment or course. Permission-service failure denies access.
- Learners use a pseudonymous LTI identity scoped to platform, client, deployment and subject. No separate VideoQ account is required for course learning. Own data and another learner's data require distinct authorization.
- Moodle administrators and instructors do not automatically own the connected VideoQ account. Billing, API credentials, the global library and VideoQ system administration require independent VideoQ authentication and authority. These functions must remain reachable through a suitable owner connection flow from Moodle.
- Moodle-managed course membership must remain authoritative. Native VideoQ invitations or public shares must not bypass hidden or conditional Moodle activities. Destructive operations on synchronized content must define how Moodle synchronization handles them before enabling the operation.
- Capability changes take effect on the next request, including pagination. Previously delivered content cannot be recalled from a browser. No permission is cached in an LTI session.

## Feature inventory and target permissions

Inventory source: `packages/trpc/src/routers/{videos,courses,qa,chat,tags,account,billing,admin}.ts` and `apps/api/src/features/lti/routes.ts`. Status describes the feature branch, not deployment or Marketplace availability.

| VideoQ function | Moodle access and target authority | Current state / remaining work |
| --- | --- | --- |
| Course video playback and evidence navigation | Current course/activity access; check the source module and LTI activity | Actual Moodle File/local-CPU range playback, cited seek/decode and feedback pass at f336a533. YouTube IFrame adapter and scoped citation bridge are implemented; actual cloud/provider acceptance and warning-free native presentation remain open |
| Lesson catalog and transcript reading | Current resource scope plus `local/videoq:viewtranscript` | Native/embedded paged cue reader implemented; actual Moodle/CPU reading, refresh and cue seek pass at f336a533. Old plugins deny this capability |
| Course AI chat, playback questions, feedback | Current course/resource access; feedback bound to the answer's session | Actual Moodle-owned File export, ASR/indexing, fresh learner startup and cited streamed answer/feedback pass at f336a533. Cloud/provider and warning-free native presentation remain open |
| Entry from an empty course | A real course LTI activity, freshly confirmed generation and current course capabilities | Paired course-entry setup/navigation/proofs implemented. Actual Moodle/API/browser checks cover empty Q&A/tags/history, roles, enrolment suspension, hide, disable/delete/repair and retained shared data; worker/real-AI and coordinated release remain gates. See `moodle-course-entry.md` |
| Personal chat history, conversations, delete/reset/export | Own pseudonymous identity, deployment and course; recheck resource scope | Actual nonempty conversation download/resume, teacher UUID denial, same-session source/enrolment checks, own deletion/model-memory erasure and report refresh pass at f336a533. All-data reset/export, legacy attribution and wider privacy verification remain open |
| Human Q&A list, search, question, reply, vote | Current course/resources; own identity for posting and edits; hidden-video threads excluded | Actual learner/teacher Q&A posting, edits, replies, votes, cross-author denial, source/enrolment changes and own deletion pass at f336a533. Empty-course entry was checked separately; external privacy and wider lifecycle remain open |
| Q&A moderation and featured questions | Explicit current course moderation capability; scoped resources | Actual teacher moderation and learner denial pass at f336a533, with own-edit rules and metadata audit. Wider privacy/operator and release verification remain open |
| Video uploads, processing status and retry | Moodle activity-edit authority for Moodle-owned uploads; server limits still apply | Existing File opt-in and synchronization/status UI; verify upload language, quota, retry and failed-job workflows end to end |
| YouTube import and direct upload | Dedicated course content capability plus delegated VideoQ owner scope | YouTube URL-source manifests, isolated managed videos/outbox, current URL/generation/capability checks, native playback and typed cleanup are implemented on paired work branches. Native cloud-only provider/processing quota policy is retained. Installed PostgreSQL/MySQL and actual archive/duplicate/recycle checks pass; independent-site completion and actual provider/AI/native acceptance remain open. See `moodle-youtube-imports.md`. Direct-to-VideoQ upload is still not exposed to LTI |
| Video title, description and transcript edit; reindex; delete | Dedicated course content capability; independently verified owner where changes affect content outside that course | Actual native description edit, reindex, confirmed transcript clear/original-ASR restore, replacement vectors, retained media/ASR and owner-sentinel isolation pass at f336a533. Source controls link to core editing/synchronization. Complete title/source/retry lifecycle and external privacy remain open; see `moodle-material-management.md` |
| Course create/update/delete/order and video/tag membership/order | Moodle course-edit authority for Moodle-managed objects; verified owner for native VideoQ objects | Catalog links to permitted core course/section/activity workflows. Fresh source catalogs and tag views follow canonical Moodle order across readable and management-only sources. Source deletion disables integration; shared external history follows privacy/retention. Complete source/course lifecycle and broader management acceptance remain open. See `moodle-course-catalog.md` |
| Tags and video filtering | Read within current resources; edit only with course content capability | Actual scoped tag CRUD/assignment, learner filtering and mutation denial pass at f336a533. Partial-manager/hidden-resource contracts and separate owner tags remain. Broader role and coordinated release gates remain; see `moodle-course-tags.md` |
| Course participants, invitations, accept/decline/revoke/remove/leave | Moodle enrolment management for managed courses; verified owner for independent VideoQ courses | Native bypass closed, including old invitation replays/queued delivery. Catalog links to permitted core participant/enrolment workflows; same-session scoped enrolment suspension was verified in the owned live entry lab. Complete enrolment workflow acceptance remains |
| Public shares and share deletion | Explicit sharing capability and owner consent; never a substitute for Moodle activity checks | Native shares cannot open managed materials/history; old links are denied and owner revocation remains available. Moodle-safe sharing/navigation still needs implementation |
| Chat usage analytics | Current `local/videoq:viewreports` capability and current course/material scope | UTC daily counts, feedback and fresh-authorized CSV implemented with verified answer provenance, read audit, privacy export/erase and configured retention. Actual Moodle/API/browser empty counts, CSV, capability revocation/restore and learner denial verified; backend and companion selected CI pass. Actual File/local-CPU positive counts/CSV, same-session revocation and post-erasure zero counts pass at f336a533. Unattributed historical answers are excluded; wider cloud and coordinated release remain open. See `moodle-course-reports.md` |
| Others' raw history and all-data management | Explicit privacy authority for others' messages; separate own-history authority for learners | Own conversation controls and core-approved external privacy operations exist. Reporting and teacher status grant no general raw-history access; complete privacy/operator workflow remains open |
| Account profile, connected apps, integration/search API keys | Independently authenticated VideoQ account owner | Account-handoff branch adds a separate sign-in and exact issuer/client/deployment ownership check before navigation to the existing UI; no credentials cross the iframe bridge. Real on-prem owner login/navigation and registration mismatch verified; broader cloud/admin acceptance remains open; see `moodle-account-management.md` |
| Plans, checkout and Stripe customer portal | Independently authenticated VideoQ billing authority | Account-handoff branch adds owner-verified cloud billing navigation; on-prem billing stays unavailable. Existing Stripe flow is unchanged; Marketplace classification still gates listing changes |
| On-premises users, passwords/access reset, quotas/usage/flags, deletion and system reindex | Independently authenticated VideoQ system administrator | Actual owned-site non-owner administrator handoff, fresh-actor quota editing, self-lockout denial and same-session current-role revocation pass. Moodle administration alone grants no VideoQ authority; original data and all 19 report receipts remain. Full provisioning/access-reset/deletion/global-reindex, cloud and coordinated release gates remain; see `moodle-account-management.md` |
| Privacy export/delete and retention | Own learner identity or an explicitly authorized privacy officer; scoped external records | Privacy branch adds core-approved external export/erase with platform signatures and serialized session invalidation; audit-retention branch adds operator-configured bounded receipt cleanup with permanent replay barriers; actual standard core UI approval/task/download of 19 report receipts and other-user download denial verified on the owned site. Complete subject erasure, peer/model/provider/legacy operator process and rollout remain gates; see `moodle-privacy.md` |

## Transcript protocol and compatibility

`POST /api/lti/materials` returns only current course materials and their current permissions. `POST /api/lti/transcript` accepts `{videoId, cursor?, limit?}` and returns cue text, timestamps and a next cursor. It does not return file keys, download URLs, owner IDs or raw database records. `getVideoEvidence` checks the owner and completed status and bounds transcripts to 2 MiB. Cues are rendered as text, never HTML.

The companion adds `local/videoq:viewtranscript` at course context, allowed for standard student, teacher, editingteacher and manager archetypes. Existing Moodle File/LTI visibility checks still run first. Custom roles and overrides can remove transcript reading without removing AI chat. The backend requires a positive permission from a fresh authenticated materials-service or signed-proof access response. Missing permissions, unchecked registrations, denied permissions and unavailable services never grant transcript reading.

The iframe announces `features.transcripts` as protocol support, not authorization. The native Moodle reader sends origin/source/channel-bound requests through the existing private LTI transport. Only the frame holds the bearer credential. Both the list and every transcript page are independently authorized. Older companion versions retain chat; older backends do not announce this feature, so the new companion keeps its reader hidden.

## Verification gates

Access responses include permission fields only when the new backend sends
`includePermissions: true`. Older backends receive the original strict response
shape. New backends accept older responses but cannot infer transcript rights
from them. This supports either upgrade order without granting a capability
that Moodle has not positively checked.

1. API tests: permitted learner, current capability revocation, resource removal/hiding, cross-course IDs, VideoQ membership removal, unchecked/older registrations, forged origin and unbounded access-response rejection.
2. Browser contract tests: native and embedded readers, paging, timestamp navigation, escaped untrusted text, credential isolation, failed/revoked requests and narrow screens.
3. Moodle installed-database checks: clean install and upgrade register the capability and defaults; course-specific overrides take effect without granting access to other courses.
4. Full isolated Moodle + VideoQ + AI test: Moodle-owned media, current custom roles, enrolment suspension, native startup, all implemented functions and privacy behavior. Unit and mocked transport tests alone do not satisfy this gate.
5. Review, CI and coordinated backend/companion release. The current published source branches and prepared Marketplace ZIPs remain separate from this unreleased work.

The isolated installed-site foundation for gate 4 is described in
`moodle-cpu-acceptance.md`. Its current role/media/network checks perform no AI
calls and do not satisfy the complete pipeline gate. Companion source/actual
archive acceptance is recorded in `moodle-youtube-imports.md`.

Full teacher-management verification, remaining Q&A entry/lifecycle work, broader owner/admin handoff acceptance and privacy work above are still required before claiming full functional parity. See `moodle-course-qa.md` for the scope and verification of the Q&A increment.

See `moodle-personal-conversations.md` for the personal-conversation increment,
including resource restrictions, deletion, retention and external privacy limits.

See `moodle-course-authority.md` for persistent source provenance, native
membership/share/media safeguards, recoverable historical backfill and the
coordinated release requirement before teacher management is enabled.
