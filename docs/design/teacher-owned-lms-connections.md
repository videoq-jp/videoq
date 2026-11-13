# Teacher-owned Moodle and Classroom connections

Both integrations separate installation authorization from teaching ownership.
The Moodle installer identity is retained only to authorize site registration and
revocation. It never supplies the default course owner or quota. Classroom's
installation configuration contains its origin only, with no static course map.

A teacher starts from the actual LMS course, proves current teaching authority,
then independently signs in to VideoQ and selects an existing owned native course
for either provider. Videos are added and edited in VideoQ, never imported from Moodle. The course's
VideoQ owner supplies storage, processing and AI usage and may read/export its
question logs through the normal owner interface. Student VideoQ accounts are
not required. Co-teachers retain LMS-scoped teaching capabilities, without gaining
access to the owner's account settings, other courses or billing credentials.

`teaching_connections` uniquely binds provider, installation and external course
to the verified LMS teacher subject, VideoQ owner and course. A disconnected
connection stays reserved to its original owner; another co-teacher cannot take it
over. Explicit ownership transfer is not implemented. The owner can reconnect the
same course. Account sharing is not used as a workaround for co-teaching.

Connection tickets expire after ten minutes and are consumed atomically. Moodle
requests use endpoint/body-bound, single-use platform assertions and a fresh
materials-service capability check. Classroom uses the verified Google subject
and encrypted account credential. Both recheck teaching authority at confirmation.
The confirmation requires a normal VideoQ browser session and approved Origin.
Concurrent competing teachers serialize on the external context and cannot overwrite
each other's course. Browser inputs cannot choose a VideoQ owner or elevate an LMS role.

Synchronization refuses linked native courses as well as unconnected or disconnected contexts. Media creation and
quota admission resolve the owner from the exact connected course, never from the
installation contact. LTI registration intersects resource/course ownership with
the active teaching connection. Copying an external course does not copy the
connection. Privacy exports/erasure use installation-scoped subject keys across
all teacher owners; the installer is no longer the data-owner filter.

Deploy generated migrations 0063 and 0064, the API, web and companion together, and reapply
the database security profile to grant the API role access to the new table.
The old static Classroom mapping is rejected. Existing bulk-owned courses are not
transferred or deleted automatically. A fresh explicit teacher connection selects an existing native course; historical media/logs remain with their previous account.
The account settings list individual Moodle/Classroom course connections.

## Native viewer feature parity

Classroom and Moodle use the same learner/owner feature split as the native
VideoQ course viewer. Learners get video selection/playback, overview, course Q&A,
AI chat with citations and Good/Bad feedback. Chat resumes automatically; no
new-conversation, private-history, per-conversation export or delete controls appear.

The connected teacher/VideoQ owner gets Chat / Course question history, the latest
100 question/answer logs with author attribution, and full CSV export. Both use
the native history repository and CSV implementation. Current LMS teaching
authority AND the connection's exact teacher subject are required on every read
and export; co-teaching alone never grants the owner's course logs.

Transcript, tag management and aggregate reports are not surfaced as extra LMS
viewer tools. Course/video authoring, account settings and billing remain in the
independently authenticated VideoQ application. Moodle and Google visual styles
are platform specific; the learner functions are shared.

## Installed Moodle verification

The [2026-11-13 installed verification](../evidence/moodle-linked-20261113/README.md)
exercises administrator pairing, teacher course selection, actual two-video
playback and AI answers, student-attributed owner history/CSV and co-teacher
refusal. Moodle signs learner names/emails; the server snapshots them with each
answer using the existing author column, also including that snapshot in the
subject's privacy export. No learner-facing consent notice was added to the viewer.
