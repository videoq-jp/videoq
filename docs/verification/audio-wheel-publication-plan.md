# Proposed bounded audio wheel publication

Publication is disabled in `audio-wheel-publication.json`. The initial candidate run
45692939587 built and scanned a wheel, but its native command failed with permission
denied and `tee` masked the exit status. It cannot authorize publication or lock adoption.

After corrected native execution and independent artifact review, a separate reviewed
commit must pin the exact successful run, attempt, head, tested merge, artifact ZIP
digest, wheel bytes and complete evidence hashes. Do not assume a rebuilt wheel has
the earlier candidate's digest. No candidate code executes in the publisher.

The proposed sole scope is repository `videoq-jp/videoq`, immutable release tag
`videoq-audio-wheel-20261126-v1`, asset
`av-19.0.2-cp312-abi3-manylinux_2_28_x86_64.whl`. The separate unique reviewed publisher
tag is `videoq-audio-wheel-publisher-20261126-v1`; its exact commit must match dispatch
input, workflow revision and checkout. Tags/releases must be absent before publication;
an existing scope fails closed instead of replacing any bytes. Creating these tags,
release or asset requires coordinator authorization after review; none has been created.

The read-only job validates fresh GitHub metadata and all pinned artifact evidence.
A fresh minimal contents-write job repeats those checks, uploads the same tested bytes
without rebuilding, and creates only the fixed new release. A separate read-only runner
downloads the fixed asset URL without authentication and verifies size and SHA256.
Production lock changes follow independent anonymous readback and fresh native/full
unsuppressed security gates. Base-image masked PyNvVideoCodec assessments remain a
separate exact-content decision; this wheel does not clear those findings.

The standalone manual workflow must first become dispatchable through the reviewed
repository workflow process. Do not bypass default-branch workflow restrictions with
`pull_request_target` or execute PR scripts with write credentials.
