# Moodle course entry backend

An empty Moodle course needs an LTI launch independent of a File activity. This
branch supplies the backend contract, paired with the persistent entry, teacher
setup controller, signed proof, navigation and empty-course view in
[companion PR 13](https://github.com/videoq-jp/videoq-moodle/pull/13).
This is not full course CRUD or feature parity and is not deployed to production.

## Desired state and compatibility

`kind: "course"` identifies an entry with external ID `course_<Moodle course ID>`.
It has a real LTI resource-link identity and positive generation, but no file,
video, storage reservation, membership, processing task or AI usage. The existing
owner and installation locks serialize reconciliation. A partial unique index
permits one entry per installation/context. Constraints reject media on entries.
Existing video rows default to `kind = 'video'`; video manifests omit `kind`,
preserving their existing canonical JSON and hash.

New materials requests send `includeCourseEntries: true`. The companion must
include entries in course discovery/manifests only for this opt-in; old callers
continue receiving video-only snapshots. Existing companions ignore the new
request field and retain their old behavior. Snapshots allow at most 1,000 videos
and one entry. Entries acknowledge `completed` immediately without file export.
Backend pairing discovery advertises `courseEntries: true` so a new companion can
refuse setup against an older backend. The authenticated legacy connection also
advertises the flag, allowing push connections without S3/materials discovery.
Legacy push accepts the same canonical ID
and rejects upload and confirmation for an entry.

An entry creates or reuses only its owner's protected LMS-managed course. Its
course title becomes authoritative; delayed file manifests cannot revert it.
Changing resource kind is refused. Disabling/deleting the entry revokes that
launch and retains the shared course, other activities, Q&A and privacy history.
Deleting the course's canonical data is a separate, unfinished workflow.

## Current authorization

Every access response for an entry must contain `courseEntry: { generation }`,
matching the registered entry and the session's `resourceGeneration`, even when
readable videos exist. The companion must emit this only after checking the
current entry, real LTI activity/type, enrolled nonsuspended subject, availability,
course visibility and capabilities. A signed legacy launch proof must identify
the entry and its generation so disabling/replacing it invalidates old proofs.
An unavailable permission service, absent entry confirmation or stale generation
denies access. A generic video-less static binding does not authorize an entry.

With no readable videos, coursewide Q&A remains subject to fresh Q&A capabilities.
Both `video_id` and retained `source_video_id` filter out every source-bound post,
including deleted-source posts. Tag vocabulary management uses the current course
content capability; hidden-material tags remain hidden. Own conversation lists
and reads still require saved resource scope to be a subset of the current scope;
a known UUID permits deleting only that subject's conversation. Empty scope never
opens/commits model memory or enables chat/transcript access. There is no fake
playback ID; when actual readable videos exist, playback uses a real granted ID.

Material-list refresh uses fresh course permissions to keep Q&A and own-history
controls available even when the readable-video list is empty. Management/tag
initialization also refreshes this list; neither may hide those course controls
merely because chat is unavailable. Learning availability still controls chat,
new/continued AI conversations and transcript access.

## Release gates

Apply generated migration 0059 before the new backend. Upgrade/drain old backend
writers before the companion enables entries: an old writer cannot interpret a
course manifest. Preserve the capability opt-in in both upgrade orders.

An owned real Moodle 5.1/PostgreSQL lab exercises normal teacher POST setup,
student/sesskey rejection, signed teacher and learner LTI sessions, coursewide
Q&A posting/reply/vote/moderation, tag vocabulary CRUD and empty own-history
refresh. Real HTTPS protocol checks verify the lab CA; the fresh Chromium context
allows only the ephemeral localhost certificate. No HTTP/AI mock or fake ready
video is used in this lab. Same-session course capability revocation, enrolment
suspension and hidden-module checks deny learner access; a teacher retains core
hidden-view rights. Temporary overrides and visibility/enrolment changes are
restored. These checks supplement the separate API/PostgreSQL and fixture-browser
suites; worker/real-AI and complete source/course lifecycle acceptance remain
separate release gates. Marketplace classification and existing Stripe billing
are separate.
