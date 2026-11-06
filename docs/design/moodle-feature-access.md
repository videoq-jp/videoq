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
| Course video playback and evidence navigation | Current course/activity access; check both File and LTI activities | Existing Moodle player and scoped citation bridge; full live regression still required |
| Lesson catalog and transcript reading | Current resource scope plus `local/videoq:viewtranscript` | Implemented in this branch: paged cue reader in native Moodle UI and embedded LTI UI; old plugins deny this capability |
| Course AI chat, playback questions, feedback | Current course/resource access; feedback bound to the answer's session | Existing transport and scoped retrieval; real AI/native startup regression remains open |
| Personal chat history, conversations, delete/reset/export | Own pseudonymous identity, deployment and course; recheck resource scope | Personal saved conversations, resume/new, per-conversation deletion/export and expiry cleanup implemented in the personal-conversations branch; all-data reset/export, legacy attribution and complete live verification remain open |
| Human Q&A list, search, question, reply, vote | Current course/resources; own identity for posting and edits; hidden-video threads excluded | Implemented in the Q&A feature branch with course pseudonyms and fresh capabilities; entry from empty courses, external privacy lifecycle and full live verification remain open |
| Q&A moderation and featured questions | Explicit current course moderation capability; scoped resources | Implemented in the Q&A feature branch with own-edit rules and metadata audit; full live verification remains open |
| Video uploads, processing status and retry | Moodle activity-edit authority for Moodle-owned uploads; server limits still apply | Existing File opt-in and synchronization/status UI; verify upload language, quota, retry and failed-job workflows end to end |
| YouTube import and direct upload | Dedicated course content capability plus delegated VideoQ owner scope | Not exposed to LTI. Define canonical Moodle activity, processing lifecycle and cancellation before enabling |
| Video title, description and transcript edit; reindex; delete | Dedicated course content capability; independently verified owner where changes affect content outside that course | Teacher-materials branch: native/embedded derived-field editor, optimistic revisions, audit/outbox and safe reindex/eligible retry. Source controls link to Moodle activity editing, synchronization and core course actions. Full live lifecycle/retry and external privacy verification remain open; see `moodle-material-management.md` |
| Course create/update/delete/order and video/tag membership/order | Moodle course-edit authority for Moodle-managed objects; verified owner for native VideoQ objects | Moodle course synchronization exists; management parity and conflict handling remain open |
| Tags and video filtering | Read within current resources; edit only with course content capability | Not exposed to LTI; prevent access to owner-wide tag counts or other courses' videos |
| Course participants, invitations, accept/decline/revoke/remove/leave | Moodle enrolment management for managed courses; verified owner for independent VideoQ courses | Native membership/invitation bypass closed in the authority branch, including old token replays and queued delivery; Moodle-native enrolment navigation/equivalents and live revocation checks remain |
| Public shares and share deletion | Explicit sharing capability and owner consent; never a substitute for Moodle activity checks | Native shares cannot open managed materials/history; old links are denied and owner revocation remains available. Moodle-safe sharing/navigation still needs implementation |
| Chat history management and analytics | Own-history controls for learners; dedicated reporting capability for scoped aggregate reports; explicit privacy authority for others' raw messages | Not exposed to LTI; define reporting minimization, audit and retention |
| Account profile, connected apps, integration/search API keys | Independently authenticated VideoQ account owner | Existing VideoQ account UI only; add owner handoff/navigation from Moodle without exposing credentials through postMessage |
| Plans, checkout and Stripe customer portal | Independently authenticated VideoQ billing authority | Existing VideoQ billing only; add owner navigation, preserve existing Stripe billing, await Marketplace classification for listing changes |
| On-premises users, passwords/access reset, quotas/usage/flags, deletion and system reindex | Independently authenticated VideoQ system administrator | Existing VideoQ admin UI only; add Moodle entry/handoff for authorized operators; Moodle admin status alone grants none of these powers |
| Privacy export/delete and retention | Own learner identity or an explicitly authorized privacy officer; scoped external records | Moodle provider callbacks exist; external VideoQ learner-data lifecycle and operator process need implementation and evidence |

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

Teacher management, remaining Q&A entry/lifecycle work, owner handoff and privacy work above are still required before claiming full functional parity. See `moodle-course-qa.md` for the scope and verification of the Q&A increment.

See `moodle-personal-conversations.md` for the personal-conversation increment,
including resource restrictions, deletion, retention and external privacy limits.

See `moodle-course-authority.md` for persistent source provenance, native
membership/share/media safeguards, recoverable historical backfill and the
coordinated release requirement before teacher management is enabled.
