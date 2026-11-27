# Runtime and package manager updates

Dependabot owns supported dependency updates: npm and uv project dependencies, GitHub Actions, Docker/Compose image tags and digests, Terraform providers, and the optional Git submodule. This includes Node.js, Python, Lambda Python and uv container images. Dockerfiles are authoritative for image pins; runtime discovery never rewrites their `FROM` lines.

The custom Runtime Updates workflow handles interpreter discovery and rendering that Dependabot cannot perform in this layout. `.github/runtime-versions.json` records local/CI Node.js and Python versions and verified npm, pip and uv distribution downloads. It generates `.node-version`, `.nvmrc`, `.python-version`, `packageManager` in `package.json`, and the managed npm/pip installation blocks in Dockerfiles. Container versions can advance independently of local/CI versions; normal CI validates compatibility.

Runtime Updates checks official release information daily at 09:13 JST and on manual runs, then creates update PRs. It reuses the existing `PATCH_BOT_APP_ID` / `PATCH_BOT_PRIVATE_KEY`, requesting contents and pull-requests write access plus administration read access to check protection settings. Because it uses an App token, normal PR CI runs. It uses no production credentials. Manual runs default to dry run, and `runtime` and `channel` select the target.

Fix updates in the current line and updates to a new line get separate PRs. For Node.js, the targets are the latest release in the current major and any LTS newer than the current one. Python separates the latest in the current line from the next stable line. Bootstrap tools apply only the exact versions declared in `.github/runtime-tools/`; npm and pip separate the current major from a new major. uv below 1.0 treats minor as a line. Prereleases and downgrades are excluded. Dependabot handles Docker tag and digest refreshes separately.

Current-line non-image updates produce one PR combining the manifest, distribution hashes, and generated files, which merges automatically after normal CI and strict branch protection pass. New lines (`next`) require review. Unavailable Python builds, wheels, and compatibility errors show as failures and are not merged by skipping checks. A failed new line does not block security fixes for the current line.

On main pushes and CI completion, Dependency Automation rechecks state and regenerates only the current PR selected by the queue. Runtime Updates does not itself watch main or CI events; it handles only the daily discovery and explicit runs from the controller. There is no scheduled polling to follow main. Writes to the same line of the same runtime are serialized.

Update PRs edited by a person and unmanaged branches with the same name are not overwritten. Original publications and subsequent Claude repairs are verified by exact parent commits, trusted receipts and allowed file changes. Discovery preserves a repaired PR instead of regenerating away its compatibility fixes. Manual commits or out-of-scope files cancel automerge. If main changes along the way, the next event rechecks it. An unedited current PR whose update has already reached main is closed. A manually closed proposal is left closed and its branch is preserved; daily discovery skips it without an error. Resuming that line requires explicitly reviewing and reopening or replacing the preserved branch.

To stop: `RUNTIME_AUTOMERGE_ENABLED=false` (`DEPENDENCY_AUTOMERGE_ENABLED=false` stops all dependency updates). Anything already queued must be removed separately. Per PR, `no-automerge` stops automerge and `no-runtime-update` also stops regeneration. Dependency Automation checks label changes.

All supported Docker images use Dependabot. Worker and whisper Python image updates stay within their reviewed minor series: Dependabot still updates patch versions and image digests, while a move to a new Python series requires compatible native wheels and review of both build and runtime interpreters. Claude CI repair and conflict resolution support both Dependabot and managed runtime PRs, including `next` runtime proposals. Successful `next` proposals still require human review. Security failures and changes outside the permitted application compatibility scope still require human intervention.

```sh
python3 .github/scripts/runtime-versions.py check
python3 .github/scripts/runtime-versions.py sync
python3 .github/scripts/runtime-versions.py plan --runtime node --output runtime-plan.json
python3 .github/scripts/runtime-versions.py plan --runtime python --upgrade --output runtime-plan.json
```

`plan` is read-only and writes the proposed change as JSON. Node.js distribution data comes from nodejs.org, Python from python.org, npm distribution metadata from the exact npm registry release, pip wheel metadata from the exact PyPI release, and uv archive metadata from the exact official GitHub Release. Bootstrap tools never enumerate releases to select a newer version. Before installing npm, pip, or uv, the reviewed manifest's hashes are verified. uv supports amd64 and arm64 on Linux and macOS. npm install scripts, uv source builds, and unverified pip bootstrap scripts are not run.

Runtime Updates changes Python pins for CI and local development. Dependabot updates Lambda and other container pins separately. Native processing and vulnerability scans run in the Lambda ARM64 image.

## Dependabot-owned bootstrap tool versions

`.github/runtime-tools/package.json` declares the npm bootstrap version, and
`.github/runtime-tools/requirements.txt` declares pip and uv. Dependabot owns
version selection in these standard manifests. These are inputs to the verified
bootstrap installers, not dependencies of the application or a new service.

The update has two reviewable stages: merge the Dependabot manifest PR, then the
existing daily Runtime Updates run (or a manual run) resolves only that selected
release's official URL and digest and proposes the generated files together with
`.github/runtime-versions.json`. The latter records the **applied** versions and
hashes; the tool manifests record the **requested** versions. A temporary difference
is expected while the generated PR is pending. Source-manifest PRs require review;
they are outside the controller's automatic merge allowlist. Current-line generated
PRs retain existing CI/queue policy; new lines retain manual review. This retains
an extra generated PR instead of adding a privileged PR mutation workflow.

Node.js/Python interpreter discovery remains custom because `.node-version`,
`.nvmrc`, and `.python-version` are not Dependabot update manifests. Container
images continue to use Dependabot independently. Native build recipes, their
provenance manifests, and the NumPy prerequisite copied from `uv.lock` require
coordinated changes and are not independent package-update sources.

Standalone DB maintenance npm dependencies, on-prem signature verification,
Ansible requirements, and the PHP acceptance image are now also watched by
Dependabot. Deployment/infrastructure/tooling PRs retain their existing review
requirements rather than extending the automatic merge or Claude repair scope.

## Lambda Python patch versions

CI and local development use the manifest's exact Python version. Lambda pins the AWS-distributed image by digest, with updates proposed by Dependabot. Its Python version can differ from local/CI Python; required CI must pass before any image update merges.
