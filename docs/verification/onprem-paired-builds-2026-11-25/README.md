# Controlled build result

The frozen shared-compiler candidate shortened cold image builds in all three prospectively specified same-runner pairs. The ratio of mean cold times fell **41.72%**, from 2,215.15 s to 1,290.96 s. Parallelism remains one. This is an image-build result, not a whole-CI or billing claim.

| Pair/order | Baseline cold | Candidate cold | Reduction | Baseline/candidate warm |
|---|---:|---:|---:|---:|
| 1 AB | 1873.348 s | 1063.697 s | 43.22% | 1.883 / 1.441 s |
| 2 BA | 2899.004 s | 1712.088 s | 40.94% | 3.121 / 2.520 s |
| 3 AB | 1873.105 s | 1097.093 s | 41.43% | 1.995 / 1.828 s |

Every original hosted job failed its final comparator because fresh builders have distinct container-owned cgroup paths. The original workflow remains **failure**. Reviewed validator `7189627c` maps only the exact verified selected-container scope, preserving membership topology, owned limits, external paths/limits, source, package inventories and measured/smoked/scanned image checks. All three retained raw archives pass that corrected validator; their independent ZIP hashes and original job outcomes are in `summary.json`. No expensive rebuild was used to erase the failure.

The experiment contains 12 cold/warm rounds, 36 component build invocations and 18 exact final measured/smoked/scanned image configurations, with zero build/smoke/scan failures. Baseline cold compiler executions were six; candidate executions were three; warm executions were zero. Actual source and VITE changes reused the compiler while changing their application image; an actual modified patch failed its checksum; recipe, parent refresh and compiler flag changes each compiled again. All six controls passed. The original rejected parallelism experiment remains separately retained and is not reinterpreted.

Both strategies used verified effective 4 CPU / 8 GiB / no-swap BuildKit limits, distinct fresh pinned builders, the same host within each pair and no external cache import/export. CPU models and runner images vary across pairs and are recorded, including the slower BA host. Host resource samples are observations, not isolated CPU/RSS measurements; retained first-variant images make disk occupancy order-dependent. Signing keys and builder caches were never uploaded. Recipe/patch/checksum/signature checks and full security gates were preserved.

Measured cold/warm runner time totals were 6,653.110 s baseline and 3,879.338 s candidate. The full experiment consumed 13,880 runner seconds, including setup, full gates and 2,445 seconds of one-time invalidation controls. Fixed quota/memory budgets and host samples are in the JSON; they are cost proxies rather than actual billed money or CPU consumption.

The decision supports the shared application-independent compiler graph while keeping parallelism one. Final integration includes later tests, main features, migration renumbering and caller fixes, so its source/build contexts are not byte-identical to frozen merge `04dcbaae`. Its own normal smoke/scans and all required CI must pass before merge. Three pairs do not establish a production latency SLO or broad hardware distribution.
