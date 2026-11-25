# Proposed bounded audio wheel publication

This records the exact reviewed artifact and bounded publication contract. Any
further write still requires coordinator authorization; republishing is forbidden. Run 45703318443 attempt 1 succeeded on head
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
`av-19.0.2-cp312-abi3-manylinux_2_28_x86_64.whl`. The unique historical publisher
tag is `videoq-audio-wheel-publisher-20261126-v1`, fixed at
`14634eb281a90f3e575b8cf469412adc57b807dc`, as is the release tag. Existing tags/releases fail closed;
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
   absence, then atomically creates the fixed release ref with POST git/refs at
   the reviewed SHA (a raced ref returns 422 and fails closed). It rereads the
   exact ref and uses --verify-tag --latest=false --prerelease to upload tested wheel bytes
   without rebuilding or changing repository Latest.
4. A separate read-only invocation runs
   `python3 .github/scripts/audio-wheel-publication.py readback --revision REVIEWED_SHA`.
   It verifies the fixed tag commit, public release identity and sole expected
   uploaded wheel asset before and after its unauthenticated byte download;
   size/SHA256 must match, and ref/asset drift rejects adoption.
   Only then may a reviewed production lock update use the fixed release URL/hash,
   followed by fresh native and full unsuppressed normal security gates.

The coordinator published release 458679721 / asset 793244875 from reviewed
publisher commit 14634eb2, verified anonymous exact-byte readback, then corrected
only its release metadata to `prerelease=true` / `make_latest=false`. The asset,
tag commit, size and SHA256 stayed unchanged. Independent inspection had observed
this artifact release returned by `/releases/latest` despite the original
`--latest=false`; no pre-publication Latest baseline was captured, so preservation
of that prior selection is not claimed. A prerelease contract prevents treating
this artifact-only release as a stable application release. Readback now rejects
stable metadata and binds the historical tag commit explicitly, separately from
the current reviewed validator checkout SHA. It never retargets either tag.
No production lock or assessment is changed by the publisher contract itself. Do not use privileged PR execution or broaden any
package scope to bypass workflow registration or publication constraints.
