# Moodle native UI and server learning API

## Required result

Moodle owns the learning interface, login, course context and capability checks.
The companion renders chat, saved conversations, Q&A, material editing, tags,
reports and transcripts through Moodle templates and JavaScript. VideoQ retains
the shared learning services, AI processing, indexing, persistence and erasure.

No VideoQ iframe is used for presentation, authentication or hidden transport.
The browser calls Moodle endpoints. Moodle's PHP calls the VideoQ learning API
over verified HTTPS. Existing browser-LTI clients remain a separate transport;
their user identities and domain services are reused, not copied.

## Native request contract, version 1

All learning operations are POST endpoints under `/api/lms/native`:
`materials`, `transcript`, `history`, `messages`, `messages/stream`, `feedback`,
`conversations`, `qa`, `management`, `tags`, and `reports`.

Moodle signs an RS256 assertion using its existing registered platform key and
sends it only in the server-side Authorization header. The protected header type
is `videoq-native+jwt`. Credentials are never returned to browser JavaScript.

The signed claims are:

- `iss`: registered Moodle issuer; `sub`: registered client ID.
- `aud`: the exact configured VideoQ origin plus the operation endpoint.
- `deploymentId`, `subject`, `contextId`, `resourceLinkId`: Moodle identities.
- `bodySha256`: SHA256 of the exact UTF-8 JSON request bytes.
- `iat`, `exp`, `jti`: a maximum 60-second assertion and unique UUID nonce.
- `sessionId`: a random 32-byte identifier retained in the Moodle PHP session.
- `sessionStartedAt`, `sessionExpiresAt`: a fixed session window of at most one
  hour. These values are cached with sessionId, not recomputed on every call.
- `locale`: `en` or `ja`; `version`: `1`.
- `accessProof`: the existing Moodle course-access proof for a legacy registered
  course-access callback; current material-service registrations use the subject
  directly.

Owner IDs, VideoQ course IDs, roles and capabilities are not assertion inputs.
VideoQ resolves the current registered binding, queries current Moodle authority
and intersects it with the connected VideoQ owner's course membership. Unknown
issuers never choose a network/JWKS URL. Browser Origin headers are refused on
this server-only API. Request sizes remain bounded, with the existing larger
budget only for material editing. Responses and streams are private/no-store.

## Session and erasure invariants

The subject hash is identical to the existing LTI subject identity, preserving
saved conversations, Q&A authorship and erasure scope across the migration.
Native session records use the existing session-data locks and erasure routines.
They cannot authenticate through browser-LTI bearer endpoints.

A signed request nonce is consumed atomically. The first request creates a data
session and a one-time started marker. Later requests preserve the stored scope
union and original expiry. The marker contains no subject metadata and expires
shortly after the original session. If erasure/revocation removes the data
session, the original Moodle session cannot recreate it. Owner/session locks
retain the existing barrier against writes racing with erasure.

Moodle must not silently replace an unexpired, refused session. It creates a new
random identifier only for a new/expired local session or a deliberately changed
connection/source context, after current Moodle login/capability checks.

## Moodle implementation boundary

Ordinary operations use Moodle's session-authenticated external functions and
core/ajax. The PHP endpoint derives the user from the current session, validates
course/activity availability and capabilities, then signs the API request. The
browser cannot select an actor, owner, upstream URL or authorization header.

Streaming has a same-origin Moodle endpoint with login, sesskey and course
checks. After the cached native session is selected, PHP releases the Moodle
session lock and relays the VideoQ event stream incrementally. Model work and
durable processing remain in VideoQ. CSV and conversation downloads also pass
through the authenticated Moodle boundary.

## Shared connector boundary

The native and privacy APIs, material contracts and course capabilities are shared
LMS services. `features/lms/providers/moodle` owns Moodle pairing, the owner handoff
and the legacy `/local/videoq/access.php` callback. The registered connector service
uses its configured OAuth, JWKS and context API endpoints; common learning handlers
do not construct Moodle URLs. Compatibility re-exports preserve existing imports.

Subjects, contexts, resource links, source IDs and export job IDs are opaque strings
of 1–255 characters. Preserve their case and exact value, including through privacy
requests. Source file revisions accept Moodle's existing 40-character SHA-1 or a
64-character SHA-256 hexadecimal digest. External IDs do not determine material
kind or authority: stored kind/context, generation, owner and current permissions
still constrain every operation. Synchronization keys encode delimiter-containing
IDs unambiguously while retaining existing delimiter-free Moodle keys.

Existing public scope URLs, `moodle-native-*` session record names and identity
hashes remain unchanged. These persisted compatibility names do not choose a
provider; changing them would invalidate sessions or disconnect privacy erasure.
There are no additional database migrations or duplicated AI/processing services.

An independent connector fixture uses UUID subjects, URI-shaped contexts/resources,
SHA-256 revisions and separate issuer/JWKS/OAuth endpoints. It exercises real
signatures, API handlers, PostgreSQL bindings, current permission revocation,
subject erasure, model-memory tables and cross-connector isolation. Its controlled
HTTP/model-data fixtures do not establish live support for a named third-party LMS.
Each new LMS still needs an adapter for its enrollment, capabilities and source
delivery. See [operator provisioning](../guides/lms-integration.md#other-lms-connectors).

## Acceptance

The pre-refactor Moodle baseline, backend `f41e30c3` with companion `eb2cca35`, passes the
[17-phase actual native acceptance](https://github.com/videoq-jp/videoq/actions/runs/42461040590/job/128670242218).
Real Moodle PHP signatures, protocol 1, File/local-CPU processing, learner/teacher
operations and core-approved subject export/deletion are verified. Original
Moodle-session read/write requests are refused after deletion, while peer replies
and shared material are retained. Native browser requests carry no VideoQ bearer
or assertion, File pages create no application/authentication frame, and the
390px Moodle layout is visually inspected. The old iframe result remains a
separate historical baseline.

Focused security/database cases cover signature/endpoint/body binding, fresh
authority, actor isolation, nonce replay, concurrent scope preservation and the
erasure/session barrier. These criteria also apply to future transport/session
changes. Standard installer ZIPs match all 71 committed files at the accepted
companion revision. See [the feature/evidence map](./moodle-feature-access.md) for
the actual-versus-controlled coverage and edition-specific limits.

## References

- [Moodle 5.1 Output API](https://moodledev.io/docs/5.1/apis/subsystems/output)
- [Moodle 5.1 AJAX](https://moodledev.io/docs/5.1/guides/javascript/ajax)
