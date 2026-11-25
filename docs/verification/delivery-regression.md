# Delivery regression gates

## Deployed source compatibility (#1681)

`.github/release-compatibility.json` pins two independently deployed consumers:

| Consumer | Source | Successful deployment receipt |
| --- | --- | --- |
| Cloud API/background consumer | `1d97335bec786c5a626cd848dfe1f30a5747735f` | [CD job 138890369579](https://github.com/videoq-jp/videoq/actions/runs/45519843216/job/138890369579), production-app deployment 8044929726 |
| Python media consumer | `12a5e668daf1e5e608a971dfd4bd428688e359b6` | [CD job 138643359543](https://github.com/videoq-jp/videoq/actions/runs/45448577612/job/138643359543) |

These are source pins backed by successful cloud deployment receipts. They do
not identify a customer's installed on-prem version or prove a current live
runtime revision. Published on-prem releases must not be labeled installed.
Update pins through review after checking the deployment receipt and retain any
older versions still supported in mixed operation before removing a baseline.

Run `COMPATIBILITY_PYTHON=<locked-worker-python> node --import tsx
.github/scripts/release-compatibility.mjs` from the repository root. The runner
extracts only relevant source from the exact Git objects; it never downloads
mutable branches or imports a candidate's copy as the old consumer. Each old
producer uses its own historical vectors, and the candidate uses its own vectors.
Real TS and Python message builders emit accepted messages. Malformed wire
vectors bypass builders to exercise consumer rejection. Each producer is tested
against both versions of both execution entry points (16 combinations).

The checks require acceptance/rejection, canonical JSON and SHA-256, rejection
before claiming work, one successful effect followed by completion, and a
redelivery that observes completion without repeating the effect. The lease
repository is an in-memory test port; existing database repository concurrency,
lease and outbox integration tests remain required separately. This is a wire
and execution-entry-point gate, not a proof of every task's provider behavior.

`delivery-regression` is always selected and explicitly required by `CI Success`.
Existing CD and On-prem Release source validation require successful push CI for
the exact current main SHA, so neither manual dispatch nor workflow_run may use
a failed compatibility result to authorize a mixed rollout. There is no skip or
"accept incompatibility" input. A failed combination blocks release: retain the
old routing, use the dedicated queue/group routing and drain procedure in the
[release contract](../architecture/responsibility-and-release-contract.md), and
land a separately reviewed migration with its own routing/drain acceptance
before removing an obsolete wire version. Do not repin to the candidate merely
to make a failing test green.

## Automated browser CORS (#1682)

Install API/web locked npm dependencies, the worker's locked Python dependencies,
and Playwright Chromium. Run:

```sh
node apps/api/scripts/cors-regression.mjs --install-browser
CORS_ACCEPTANCE_PYTHON=<locked-worker-python> node apps/api/scripts/cors-regression.mjs
```

The runner owns a uniquely named disposable Garage container with the same
digest/config as local development, a dedicated acceptance bucket, and an
automatically allocated loopback port. It uses the existing Hono/storage fixture
and clicks both pages with Chromium's normal browser protections. All ten
allowed-origin and five denied-origin cases must pass, including multipart ETag
visibility, completion with assembled byte/hash verification, API error
readability, and MCP credentials omitted/included. Server traces must also prove
the denied JSON POST and signed PUT were absent and the denied storage preflight
was rejected. A missing/partial/failed report exits nonzero.

Only sanitized fixture reports and a fixed-text failure stage are uploaded.
Signed URLs, browser console/network dumps, cookies, authorization and fixture
stderr are never uploaded. Objects/uploads, browser and fixture servers are
closed in `finally`; only the runner's own container is removed. There is no
production endpoint input. This does not replace full OAuth, TLS/CDN or
deployment-origin acceptance.

## Comparable build experiment (#1678)

The historical observation [run 45523578420](https://github.com/videoq-jp/videoq/actions/runs/45523578420)
spent 29m57s in sequential API/worker/web builds. It is one observation, not a
distribution or an estimate of savings. Default CI remains sequential pending
comparable successful measurements.

Dispatch `On-prem build comparison` at one candidate SHA. Four identical hosted
Ubuntu 24.04 jobs compare parallelism 1 versus bounded parallelism 2, with two
independent cold runs per mode; each cold run is followed by one warm repeat on
that same runner. No cache is imported from PRs, registries or a previous run.
The draft experiment PR uses `[delivery-benchmark]` in its title and starts the
same matrix on PR creation/reopening/labeling. Synchronization alone does not
silently spend four more runners; re-trigger deliberately after source changes.
Only the disposable runner's local BuildKit content cache is used, with source
COPY/Dockerfile/build argument/base digest changes invalidating dependent layers.
A new runner discards the entire cache; security package installation layers
cannot survive into a later CI run. A failed build never supplies an artifact.

`build-onprem-measured.py` retains per-component elapsed time, exit status and
loaded image ID, total elapsed time, runner CPU count/load, memory availability
and disk availability sampled every two seconds. It loads the same candidate
tags used by the existing HTTP/import/migration/header smoke tests and complete
unfixed-vulnerability scans/SBOM steps. The comparison does not change any normal
CI upstream-image scans, lifecycle selection or branch-protection requirements;
unchanged third-party upstream scans are outside this application-build experiment.
No image is rebuilt between final measurement, smoke test and scan.

Compare cold and warm groups separately, retaining individual samples and
failures; compare runner seconds as the cost unit, plus minimum memory/disk and
load. Actual currency cost requires the repository's billed runner rate and
must not be invented. Two repetitions are a small initial sample: expand the
sample if variance or any resource/failure regression makes the choice unclear.
Adopt bounded parallelism only after both successful repeated cold/warm groups
and the unchanged security/runtime checks support it. Never choose a faster
variant that fails or exhausts runner resources.

Local verification on 2026-11-25 passed 16 compatibility combinations × 58
vectors, negative controls for hash/rejection/completed-replay corruption,
803 deployment-policy/security Node tests, and 167 Python workflow tests
(7 existing environment-dependent skips). An exploratory local baseline failed
after 132.898s (all three builds failed, including BuildKit's
`metadata_v2.db: read-only file system`); it is not a valid timing comparison.
The Docker daemon subsequently became unavailable. Successful repeated builds,
cost/failure comparison and a successful automated browser run remain required
before closing #1678/#1682; no successful result or speedup is claimed here.
