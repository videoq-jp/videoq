# Moodle course catalog and visibility

Moodle owns synchronized File activities, section/activity order, course settings
and enrolments. The companion catalog links teachers to permitted core
upload/edit/organize/course/participant workflows. It requires both course-wide
`local/videoq:managecontent` and `moodle/course:manageactivities`, and checks
module view/management rights for each source. Core destinations independently
recheck capabilities and retain their POST/session-key/confirmation workflows.
Catalog GET requests do not create or change activities.

Stable assistant URL lookup compares complete URL strings through a closed
Moodle recordset. This avoids Moodle's developer-mode ban on ordinary TEXT-column
conditions, prefix truncation and database-specific case folding when enabling
multiple source activities.

New File activities require explicit VideoQ opt-in after saving. Upload size,
language, quota, processing/retry and cancellation remain in the existing source
flow. YouTube/direct-to-VideoQ imports and reporting remain unfinished. Deleting
a Moodle course revokes launches; external history follows the separate privacy
and retention process rather than being silently erased by a navigation link.

## Canonical activity order

Source associations follow Moodle's current ordered section sequences, including
manual legacy associations. Missing/deleted modules sort after current activities
and cannot become permitted resources. Fresh access still rechecks visibility,
availability, enrolment, module rights and generation. Native selectors,
transcripts, Q&A filters and the teacher catalog follow Moodle order without a
sync round trip.

The backend preserves that sequence in `materialOrder` across readable and
management-only sources, excluding foreign, unbound and stale IDs. The
authenticated materials response exposes `order` after intersecting it with
current VideoQ course membership. The tag view uses it to interleave pending and
readable materials; older responses without `order` keep their fallback behavior.

## Hidden sources and current user rights

Hiding a source/course differs from disabling integration. A teacher with core
hidden-view rights must retain access while a learner without those rights is
refused. Previously hidden source/course/companion state disabled the manifest
globally and removed the binding even for an authorized teacher.

New service calls send `includeUserVisibility:true`. Only opted-in manifests omit
global visibility suppression. Legacy push negotiates `userVisibility:true`
through its authenticated backend connection. Older backends/service callers
keep the original suppression; connection failure sends no manifest. Discovery
advertises support and old companions ignore the request field. No new manifest
field, dependency or database migration is required. Existing video manifest JSON
shape remains unchanged.

Fingerprints include source/course/companion visibility, advancing the generation
even when integration stays globally enabled. Old backend sessions become stale;
fresh Moodle access determines the user's current reading/management rights.
Availability conditions retain per-user checks. Explicit disable, deletion,
missing files, source ownership and companion validity retain their previous
checks and tombstone semantics. Native/public access stays closed by the
course-authority guards.

Exports persist the negotiated mode in durable Moodle task data, with older tasks
defaulting to the original mode. Visibility/generation changes cancel stale
queued transfers before network access. A new current hidden-source export may
proceed for the explicitly enabled integration. No learner identity or session
credential is stored with the mode.

## Verification and rollout

Installed-Moodle PostgreSQL/MySQL checks cover real File storage, core
activity/section moves, capabilities, hidden learner/teacher rights, old-caller
suppression, durable export mode and stale-transfer cancellation. Synthetic
readiness acknowledgements test authorization, not AI processing. Real
Moodle/API/browser and worker/real-AI acceptance remain separate gates.

Ship this backend after the existing course-authority/entry stack, then upgrade
the companion. Older unprotected native readers cannot coexist with this managed
course data. Preserve disable/privacy recovery. Production deployment, Stripe
and Marketplace publication are outside this change.
