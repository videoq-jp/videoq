# GPU runtime dependency refresh

Ordinary `Dockerfile.vllm` builds use a digest-pinned runtime. They copy the current
security checks and license, enforce the APT security floor and exact serving
package versions, and run the complete HIGH/CRITICAL scan before publication.
They do not refresh APT indexes or reinstall CUDA/Python packages. A Launchpad PPA
outage therefore cannot block an otherwise safe application release.

`runtime-base.json` records the bootstrap image provenance and component scan.
It explicitly does not claim that the historical whole-application release passed.
The final application release must still pass all existing release gates.

To update dependencies:

1. Run **On-prem Runtime Base** manually against `main` after its push CI succeeds.
2. `Dockerfile.vllm-base` refreshes vendor repositories with strict APT error
   handling, rebuilds the exact CUDA/audio dependencies, checks imports as the
   serving user, scans including unfixed HIGH/CRITICAL findings, and emits an SBOM.
3. A separate privileged job publishes the scanned archive without executing it
   and signs provenance and the package inventory. Failures publish no candidate.
4. Verify the candidate on the actual GPU, then review a PR updating the immutable
   `FROM` digest and `runtime-base.json`. Ordinary CI scans the complete resulting
   image again. If a new vulnerability affects the pinned base, that scan blocks
   promotion until a fixed base is available; it is never waived for availability.

The dependency refresh remains allowed to fail during an upstream outage. No
HTTP downgrade, signature bypass, missing-index acceptance, or TLS bypass is used.
