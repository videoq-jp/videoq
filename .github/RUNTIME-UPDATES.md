# Runtime and package manager updates

`.github/runtime-versions.json` is the single source of truth. It records versions and distribution hashes for Node.js, Python, npm, pip, and uv, and generates `.node-version`, `.nvmrc`, `.python-version`, `packageManager` in `package.json`, and the applicable Dockerfiles. CI, builds, and deployments use these pins.

Runtime Updates checks official release information daily at 09:13 JST and on manual runs, then creates update PRs. It reuses the existing `PATCH_BOT_APP_ID` / `PATCH_BOT_PRIVATE_KEY`, requesting contents and pull-requests write access plus administration read access to check protection settings. Because it uses an App token, normal PR CI runs. It uses no production credentials. Manual runs default to dry run, and `runtime` and `channel` select the target.

Fix updates in the current line and updates to a new line get separate PRs. For Node.js, the targets are the latest release in the current major and any LTS newer than the current one. Python, npm, and pip separate the latest in the current line from the next stable line. uv below 1.0 treats minor as a line. Prereleases and downgrades are excluded. If the same Docker tag is rebuilt, the digest is also updated.

Current-line updates and image rebuilds of the same tag produce one PR combining the manifest, distribution hashes, and generated files, which merges automatically after normal CI and strict branch protection pass. New lines (`next`) require review. Unavailable Python builds, containers, wheels, and compatibility errors show as failures and are not merged by skipping checks. A failed new line does not block security fixes for the current line.

On main pushes and CI completion, Dependency Automation rechecks state and regenerates only the current PR selected by the queue. Runtime Updates does not itself watch main or CI events; it handles only the daily discovery and explicit runs from the controller. There is no scheduled polling to follow main. Writes to the same line of the same runtime are serialized.

Update PRs edited by a person and unmanaged branches with the same name are not overwritten. The App's published record is compared with the current head; manual commits or out-of-scope files cancel automerge. If main changes along the way, the next event rechecks it. An unedited current PR whose update has already reached main is closed.

To stop: `RUNTIME_AUTOMERGE_ENABLED=false` (`DEPENDENCY_AUTOMERGE_ENABLED=false` stops all dependency updates). Anything already queued must be removed separately. Per PR, `no-automerge` stops automerge and `no-runtime-update` also stops regeneration. Dependency Automation checks label changes.

Managed worker Docker images are excluded from Dependabot and updated only by runtime updates. Dependabot names without a registry (`astral-sh/uv`, `lambda/python`) are excluded too. The separate whisper service stays on Python 3.12, and its image updates keep the normal Dependabot route.

```sh
python3 .github/scripts/runtime-versions.py check
python3 .github/scripts/runtime-versions.py sync
python3 .github/scripts/runtime-versions.py plan --runtime node --output runtime-plan.json
python3 .github/scripts/runtime-versions.py plan --runtime python --upgrade --output runtime-plan.json
```

`plan` is read-only and writes the proposed change as JSON. Node.js distribution data comes from nodejs.org, Python from python.org, npm from the npm registry, pip from PyPI, and uv and standalone Python from official GitHub Releases. Before installing npm, pip, or uv, the reviewed manifest's hashes are verified. uv supports amd64 and arm64 on Linux and macOS. npm install scripts, uv source builds, and unverified pip bootstrap scripts are not run.

VideoQ updates the Python minor line for CI, local development, and Lambda together. Native processing and vulnerability scans run in the Lambda ARM64 image.

## Lambda Python patch versions

CI and local development use the manifest's exact Python version. Lambda pins the AWS-distributed image of the same minor line by digest and tracks it daily. The patch version inside AWS's image may be published at a different time than official Python.
