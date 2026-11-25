The isolated publisher copies the two artifacts from native run `45538276974`;
it does not rebuild them. Their tested merge source is
`48d69177d7dfc675c13870457ad172b90c907529`, while the PR head was
`83aa79e99b14cbdd15d2647a724b5f2c221f26e3`. Both native model/health/WAV checks
and unsuppressed strict scans passed. The fixed authorization validator pins
artifact IDs, archive digests, OCI manifests and the exact native runtime,
identity, Syft and Grype reports. A later automatic native run does not silently
replace these reviewed inputs.

The validator and OCI helper run from reviewed immutable source
`ae96bf7ea3db11be1aeb68963e0f9b32265bd428`. Read-only jobs validate both
architectures before either fresh publisher obtains `packages: write`. The
publisher executes only those sparse, pinned scripts and checksum-pinned ORAS;
it never executes a candidate checkout, Dockerfile, container, npm hook or
artifact script. It can copy only into
`ghcr.io/videoq-jp/videoq-whispercpp-candidate`. Normal release packages and
routing are unchanged. Source/job/step/attempt/expiry drift rejects publication.

After reviewing the publisher workflow revision, the coordinator creates the
unique lightweight tag `videoq-whisper-candidate-publisher-20261125-v1` at that
exact full commit SHA. First verify the name does not exist; never replace an
existing tag. Resolve the created remote tag and require its object type
`commit` and SHA to match the reviewed revision before dispatch:

```sh
# REVIEWED_PUBLISHER_SHA is the full, reviewed workflow commit, not a branch head.
git push origin "$REVIEWED_PUBLISHER_SHA:refs/tags/videoq-whisper-candidate-publisher-20261125-v1"
gh api repos/videoq-jp/videoq/git/ref/tags/videoq-whisper-candidate-publisher-20261125-v1
gh workflow run ci.yml --repo videoq-jp/videoq \
  --ref videoq-whisper-candidate-publisher-20261125-v1 \
  -f mode=whisper-candidate-publish -f reviewed_revision="$REVIEWED_PUBLISHER_SHA"
```

This uses the existing registered CI dispatch entry point. Only this explicit
mode on this exact tag skips ordinary CI jobs; normal PR/push/merge-group and
normal dispatch conditions stay intact. A request for isolated mode on another
ref fails its dispatch guard. The publisher also verifies the remote tag and
both actual SHA/workflow SHA against the supplied reviewed revision. The tagged
run cannot enter existing main-only CD or normal release routing. No
`pull_request_target` or `workflow_run` publisher executes PR code. If workflow
code needs repair after tag creation, review a new unique version and its guards;
do not move the old tag.

Publication tags include the source, architecture and publishing run/attempt;
consumer references must use the immutable manifest digests. A registry denial
fails the job and must be reported verbatim; do not select another package or
broaden credentials. Logout removes the dedicated fresh registry configuration.

A new GHCR package may be private. Publication does not authorize consumer pins:
both independent native readback jobs must pull the exact manifest **without
registry credentials**, repeat non-root/read-only/no-egress model health and WAV
inference, and scan the public registry digest without policy exceptions. If
visibility needs correction, change only this fixed candidate package, then
rerun the failed readback jobs against the same immutable digests. Preserve the
package visibility receipt and anonymous pull evidence. Chart defaults change
only after those gates pass; publishing this candidate never deploys production.
