# Controlled shared-compiler build experiment

This prospective protocol supplements the rejected first parallelism experiment;
it does not rewrite that experiment or claim a speedup before execution.

The frozen candidate contains both original Dockerfiles verbatim under
`.github/fixtures/onprem-build-baseline` and the candidate application-independent
OpenSSL compiler graph. Application source, recipes, patches, pinned base,
MAKEFLAGS=-j4, signatures, package checksums and final image checks are the same.
Only the compiler stage ancestry and reuse differ. No external cache is imported
or exported. The expensive compiler is shared only within one disposable builder.
The signing private key stays in the disposable builder cache and is never uploaded.

Three hosted runner pairs execute AB, BA, AB. Each pair uses the same host, source,
CPU model and runner image, with distinct initially fresh pinned BuildKit builders.
Every builder has a verified effective four-CPU quota and 8 GiB memory with no swap.
The verifier binds the selected Buildx node/container to its actual host PID,
kernel, affinity, cgroup and inherited CPU/memory limits before and after timing.
The comparison requires matching effective controls and actual ancestor limits.
Raw host memory, resources, timing and variation remain visible. Cold and warm
(two sequential builds of API, worker, web) are reported separately.

Both variants run the existing production HTTP, migration, worker-import, web
header/CSP and full image scan gates. Reports bind the measured IDs to actual
smoked, Syft-catalogued and still-loaded images, rejecting rebuild or retag drift.
Actual compiler vertices must show two baseline cold compilations, one candidate
cold compilation with web reuse, and all compiler vertices cached on warm repeats.

Pair one runs six real candidate controls after scans, with separate probe tags:
API source and VITE input edits reuse the compiler and change the final application
image; changing an actual security patch fails its checksum; changing APKBUILD,
the security parent refresh epoch, and compiler flags each really recompiles.
All source edits restore in finally blocks, and measured tags are never replaced.
Builders are deleted after their variant; only anonymized logs, identities, scans,
control results and resource receipts are retained, never BuildKit cache.

The prospective adoption decision requires all three pairs, full gates and six
controls to pass. Compare paired cold reductions, warm behavior, runner seconds,
resource use and failures before claiming shortening. Keep parallelism one. No
security exception, branch protection or required CI check changes for timing.
The experiment is explicitly labeled `delivery-paired-benchmark` on a PR once;
subsequent pushes do not automatically repeat this expensive protocol.
