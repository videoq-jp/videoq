# Public no-signup demo preparation

The original PostgreSQL preparation workflow was removed after the verified
D1/Vectorize handoff and Neon retirement on 2026-11-17. Existing demo accounts,
courses, videos and media remain in the current service. Do not run the historical
Neon preparation flow against production. A future demo provisioning operation
must use the current D1 API and its ownership/quota checks.

The procedure below records the historical preparation of the five owned lessons
behind `videoq-campus-basics-v1`; its guarded native recovery scripts remain
archived with the database maintenance tools.

The dedicated `videoq_public_demo` user has the approved ceiling of 100 answers
per month, 20 processing minutes and 0.1 GiB storage/upload allowances. Existing
usage counters are preserved. The account has no administrator privileges and
cannot collide with another user or a course containing other material.

Provisioning creates a random temporary login, runs the existing registration CLI
through the normal upload, worker and sharing APIs, verifies five completed and
indexed videos, signs out and removes the temporary cookie. It never seeds
transcripts, scenes, embeddings or answers. Raw API errors, passwords, cookies and
presigned URLs are not logged or uploaded as artifacts. Retries reuse fixture
hashes and the course marker; uploaded data is retained for recovery if a stage
fails. No ordinary user content is changed or deleted.

When the audit and publication checks pass, merge/deploy the no-signup demo PR.
Verify `/try` and `/en/try` with one anonymous real question and a citation seek.
The public demo's per-IP limit is 10 questions/hour. Raising the monthly ceiling
requires an explicit operational decision; provisioning never resets usage.
