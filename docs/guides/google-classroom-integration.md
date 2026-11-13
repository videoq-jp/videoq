---
title: Connect Google Classroom
description: Configure the Classroom content add-on, teacher-owned connections, and verification.
---

# Connect Google Classroom

Classroom uses a content add-on, separate from LTI and the Moodle plugins. Teachers attach existing VideoQ course materials to assignments, announcements, and materials. Students open video playback, AI questions with source citations, and course Q&A inside Classroom. Upload and processing happen in VideoQ first. Grade passback, roster synchronization, Drive imports, and automatic link upgrades are outside this integration.

## Google setup

Follow Google's [project configuration](https://developers.google.com/workspace/classroom/add-ons/developer-guides/project-configuration) and [developer journey](https://developers.google.com/workspace/classroom/add-ons/get-started/developer-journey). Enable the Classroom API and Workspace Marketplace SDK, and configure the OAuth consent screen and web client in the same project as the add-on.

For a public API origin of `https://api.example.com`, register:

| Setting | Value |
| --- | --- |
| OAuth redirect URI | `https://api.example.com/api/classroom/oauth/callback` |
| Attachment setup URI | `https://api.example.com/api/classroom/discovery` |
| Allowed attachment prefixes | `https://api.example.com/api/classroom/teacher` and `https://api.example.com/api/classroom/student` |
| OAuth scopes | `openid`, `https://www.googleapis.com/auth/userinfo.email`, `https://www.googleapis.com/auth/userinfo.profile`, `https://www.googleapis.com/auth/classroom.addons.teacher`, `https://www.googleapis.com/auth/classroom.addons.student` |

Teacher launches request the teacher scope; student launches request the student scope. Verified ID token names and email addresses support owner question history and CSV. Identity uses the signed Google `sub` claim.

Private development requires an eligible Workspace for Education test domain, licenses, and teacher/student accounts. Check Google's [prerequisites](https://developers.google.com/workspace/classroom/guides/onboarding/prerequisites). Public availability requires OAuth verification and Marketplace review; deploying this code does not publish or approve the add-on.

## VideoQ setup

Apply current database migrations, then configure these runtime values. Store secrets in the execution environment, using Workers secrets for Cloudflare. The ordinary VideoQ login variables `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` are separate.

| Variable | Purpose |
| --- | --- |
| `CLASSROOM_CLIENT_ID` | Add-on OAuth client ID |
| `CLASSROOM_CLIENT_SECRET` | Add-on OAuth client secret |
| `CLASSROOM_CONFIG` | Configuration JSON; absent or `false` disables the integration |
| `USER_SECRET_ENCRYPTION_KEY` | Existing 32-byte base64url encryption key; retain the established key |

Example configuration:

```json
{"toolOrigin":"https://api.example.com"}
```

Administrators allow the add-on. Each teacher authenticates with Google, selects **Connect your VideoQ account**, signs into VideoQ in another window, and chooses an existing course they own. Returning to the picker and checking the connection enables attachment selection. Students do not need VideoQ accounts.

Each Classroom class has one responsible teacher and one linked VideoQ course. Co-teachers can use connected materials but cannot replace another teacher's connection or export its history. Usage, history, and CSV belong to the linked course owner. Choose separate VideoQ courses to separate Q&A across classes. The removed `CLASSROOM_CONFIG.courses` format has no compatibility or implicit ownership transfer.

Connections are stored in `teaching_connections`; author snapshots use the question-author migration. Apply all migrations through the normal deployment gate. Temporary credentials use typed `lti_credentials` records and ordinary expiration maintenance. Configuration changes invalidate existing learning sessions; reopen materials afterward.

Uploaded video playback uses the existing S3-compatible signed URL configuration, including R2's S3 interface. Signed URLs follow the existing maximum one-hour lifetime. YouTube uses privacy-enhanced embeds. Playback failures do not prevent AI questions. Source citations can seek YouTube videos, but the current YouTube position is not automatically sent with a question.

## Learning and owner history

Install the private add-on in the test domain. The teacher opens the VideoQ picker from a Classroom post, signs in, connects their account and course, selects materials, and attaches them. The picker closes after Google confirms attachment creation. Students open the attachment and authenticate with their own Google accounts.

The layout follows the native VideoQ course: video and overview/Q&A on the left, video list and AI assistant on the right. Mobile puts learning panels below the video and exposes overview through **Details**. Transcript data supports answers and citations without a transcript-reading tab. Conversations continue automatically; there are no new-conversation or private-history controls. Material 3 color and typography tokens provide the Classroom styling without an additional React or Material Web runtime dependency.

The connected owner teacher can view the latest 100 question logs and export all logs as CSV. CSV includes time, question, answer, citations, feedback, learner identifier, Google display name, and verified email captured at question time. Missing identity fields remain empty; historical names are not backfilled. Owner exports require both the connected teacher identity and current Google teacher authority, rather than a generic co-teacher role. Additional profile scopes may require renewed consent.

Disconnecting removes stored Google credentials and immediately rejects their sessions. Revoking Google's account-level consent is a separate Google account action. Disconnecting does not erase posted Q&A or stored learning history.

## Authentication and access boundaries

Every learning request rechecks Google's add-on context, current role, and attachment against the linked course. Only attachments created by this add-on are accepted. Changing a material URL cannot grant access. Deleted attachments, removed enrollment, revoked API access, or an inactive connected account cause access to be refused. Copied attachments require a teacher connection in the destination class and do not inherit another class's mapping.

OAuth checks signature, issuer, audience, nonce, PKCE, one-time state, and callback cookies. `login_hint` is an account hint, never authentication. The top-level OAuth callback uses a Secure, HttpOnly, SameSite=Lax cookie; the learning iframe does not depend on third-party cookies.

Stored access/refresh tokens and account credentials are encrypted with purpose- and record-bound AES-GCM. Account credentials last at most 30 days, learning sessions one hour, and OAuth state five minutes. Without a refresh token, reuse ends at access-token expiry. Credentials travel in Authorization headers, not URL queries or the parent frame. Google error bodies are not logged. Classroom, Moodle native, and LTI session credentials are not interchangeable.

## Verification

Run the API checks:

```sh
npm run typecheck --workspace @videoq/api
npm run test:unit --workspace @videoq/api -- test/classroom-routes.test.ts test/classroom-oauth.test.ts test/classroom-view.test.ts test/classroom-player.test.ts test/lti-routes.test.ts test/lti-protocol.test.ts test/moodle-native-api.test.ts
```

Before enabling a real Google deployment, verify in the eligible test domain:

1. Teacher attachments to all three post types persist and close the picker.
2. Two students cannot access each other's private conversations; generic teachers cannot access owner exports.
3. Playback, AI streaming, citation seeking, Q&A, and teacher moderation work.
4. Return visits, access-token refresh, account switching, and reconnecting work.
5. Enrollment removal, material/attachment deletion, and disabled configuration refuse access.
6. Copies into another class require a fresh teacher connection and reattachment.
7. OAuth works with third-party cookies restricted and permitted login popups.

Local mock tests do not replace these Google checks. Follow Google's [add-on requirements](https://developers.google.com/workspace/classroom/add-ons/requirements) and [review process](https://developers.google.com/workspace/classroom/add-ons/developer-guides/review-process-overview) before public release.
