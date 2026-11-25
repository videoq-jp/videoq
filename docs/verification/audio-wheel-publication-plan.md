# Proposed bounded audio wheel publication

This is a pinned publisher candidate for independent source review, not authorization
to publish. Run 45703318443 attempt 1 succeeded on head
`eec22a499371271100a72813c52223065c2af4ae`, tested merge
`258a1524b3157c144358e795db967fcd46aaf13c`. Artifact 15063499680 has ZIP SHA256
`469f5594e3cc240edcaaaab45a29bda3d0f7786ce4dee85b32219b8f4ce25523`.
The exact 3,283,767-byte wheel SHA256 is
`75fd08d21f054bd7e1ca800f32799131926b43857e8fa2ffe43f8bc755043ffa`.
The manifest pins eight complete evidence files; read-only validation checks fresh
run/job/step metadata, ZIP identity, all 235 wheel file members, the 227 installed
runtime members, exact native ELF closure, real serving fixtures and zero-match,
zero-ignored valid raw scan. MP3 decoding yielded 160,079 samples while actual
serving yielded 159,887; each is bound to its reviewed receipt, without claiming
sample equality. Both PCM serving fixtures preserved 1,600 samples and 0.1 seconds.

Initial run 45692939587 built and scanned a different wheel but its native command
failed with permission denied and `tee` masked the exit status. That historical
success status cannot authorize anything; the failed native log remains retained.
Neither run establishes GPU execution, model-weight inference, or full image
vulnerability clearance. The actual supported native image gate and masked
PyNvVideoCodec decisions remain separate from this patched overlay artifact.

The sole proposed scope is repository `videoq-jp/videoq`, release tag
`videoq-audio-wheel-20261126-v1`, asset
`av-19.0.2-cp312-abi3-manylinux_2_28_x86_64.whl`. The separate unique reviewed publisher
tag is `videoq-audio-wheel-publisher-20261126-v1`. Existing tags/releases fail closed;
this publisher never replaces assets. The consumer's SHA256 pin rejects changed
bytes even if another repository writer later edits the release.

The standalone manual workflow is not yet registered on the default branch. The
concrete initial execution route is a fresh detached local checkout of the exact
independently reviewed publisher commit, avoiding any merge-before-adoption cycle:

1. Root creates a fresh detached checkout of the reviewed commit and checks
   `git rev-parse HEAD` against that exact SHA. It runs
   `python3 .github/scripts/audio-wheel-publication.py validate --archive /path/to/exact.zip --revision REVIEWED_SHA`
   read-only before creating any tag. No artifact scripts are executed.
2. After explicit coordinator authorization, root verifies the proposed publisher
   tag is absent and creates it once at that reviewed commit. The publisher requires
   this exact tag/commit binding before every write, with no mutable branch checkout.
3. From the same trusted detached checkout, a minimal contents-write credential runs
   `python3 .github/scripts/audio-wheel-publication.py publish --archive /path/to/exact.zip --revision REVIEWED_SHA`.
   It freshly repeats provenance and evidence validation and checks both release/tag
   absence before uploading the tested wheel bytes without rebuilding.
4. A separate read-only invocation runs
   `python3 .github/scripts/audio-wheel-publication.py readback --revision REVIEWED_SHA`.
   Its wheel download uses no authentication and must match the exact size/SHA256.
   Only then may a reviewed production lock update use the fixed release URL/hash,
   followed by fresh native and full unsuppressed normal security gates.

No tag, release or asset has been created by this preparation. No production lock
or assessment is changed here. Do not use privileged PR execution or broaden any
package scope to bypass workflow registration or publication constraints.
