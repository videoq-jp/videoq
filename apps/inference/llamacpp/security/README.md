# Upstream inference runtime assessments

VideoQ uses the upstream image unchanged, pinned by digest. Finding a CVE in an
external image triggers evaluation; it does not automatically require maintaining
a private fork. Prefer a tested upstream digest update when one is available.

For CVE-2026-109518, Ubuntu's APT client can accept an unverified package when an
on-path attacker manipulates package downloads, redirects and retries. Ubuntu
24.04 fixes it in `2.8.4ubuntu0.1`. The reviewed upstream image still contains
`apt` and `libapt-pkg6.0t64` `2.8.3`. Those packages are vulnerable; this is not a
package fix or a false positive in the scanner.

## Applicability to VideoQ

`apt-runtime-assessment.json` records a **not affected runtime use** assessment,
with the `vulnerable_code_not_in_execute_path` justification. It covers only the
listed image digest, source revision, CVE, exact package versions, Ubuntu release
and amd64/arm64 architectures in the checked VideoQ chart deployments.

- The image entrypoint is the native `/app/llama-server`, not an installation
  wrapper. The chart passes local GGUF paths and `--offline`; it does not invoke
  APT in startup, health checks, or request handling.
- The optional model init container uses the separately scanned transcription
  gateway image and `python provision.py`. It fetches pinned model files, not APT
  packages. The pre-provisioned recipe disables that init container entirely.
- The server runs as UID 10001, without privilege escalation or Linux
  capabilities. Its root filesystem and model mount are read-only; only a small
  `/tmp` emptyDir is writable. The assessment does not depend on a NetworkPolicy
  being enforced; the offline recipe additionally denies egress.
- No VideoQ Dockerfile builds a derivative of this upstream image. Its published
  history records package installation during the upstream build, which is a
  separate supply-chain trust boundary. This runtime assessment does **not**
  certify that upstream build, authorize running APT there, or cover APT in the
  host, other containers, interactive sessions, or site overrides.

The vulnerable acquisition operation is therefore outside the chart's execution
path. If that changes, reassess before promotion. A mitigation or accepted risk
with a reachable acquisition path must not be labeled `not_affected`.

## Enforcement and evidence

The llama.cpp Trivy scan retains all HIGH/CRITICAL/UNKNOWN findings, including unfixed ones,
without an ignore list or VEX suppression. Scanner errors still fail the job.
The following assessment command is the promotion gate; a raw scan returning
zero is **not** a successful security evaluation:

```sh
HELM_BIN=/path/to/helm node .github/scripts/onprem-upstream-security.cjs \
  upstream-cpu-security.json amd64 upstream-cpu-assessed.json
```

The same APT evaluation applies to the separately pinned Ubuntu 22.04
whisper.cpp images, which contain APT `2.4.14` (fixed in `2.4.15ubuntu0.1`). Their
own `apps/inference/whispercpp/security/apt-runtime-assessment.json` fixes the
digest for each architecture and package versions. The chart overrides their
`bash -c` image entrypoint with `/app/build/bin/whisper-server`, passing only local
model files. That engine also runs non-root with a read-only root and model mount
and writable `/tmp`; the separate gateway/provisioner does not receive this
assessment. Pass `whispercpp` as the fourth command argument to assess it.

The existing whisper.cpp kernel-header VEX evaluation remains separate. Its
complete scan output retains those findings in `ExperimentalModifiedFindings`.
The gate checks each such record against the explicit reviewed CVE/PURL/version
and the exact image/header inventory verified by `check-upstream-header-image.py`.
An unexpected suppression, missing inventory, changed header hash or new kernel
CVE fails; the APT assessment cannot suppress these findings or inherit arbitrary
VEX decisions. Both the complete scanner report and the resulting evaluations
are retained.

The gate validates the raw report's digest, platform, OS and entrypoint/source
identity. It renders and checks the default, model-download and pre-provisioned
CPU chart configurations, including the runtime restrictions above. Every other
CVE/package/version and any unknown-severity finding remains blocking. The raw
report and assessment, including the original finding objects, are retained as
CI artifacts. A passing assessment is never described as zero raw findings.

Both PR CI and merge-queue CI use this gate when upstream-image evaluation is
selected. The existing daily Operations run scans pinned upstream images again
with the current vulnerability database, even when no application PR is open.
Scan failure must not be treated as an empty report or automatically accepted.

## Maintenance policy

VideoQ maintainers own this assessment. It expires after at most 30 days; expiry
fails the gate. Review it at least weekly and whenever image pins, startup,
provisioning, package inventory or chart security settings change. A new digest
requires review even if its package versions look the same. Never extend the
date automatically to silence a failure.

When a patched official image is available, update its digest through a PR,
retain scan/SBOM evidence, run inference compatibility and CPU acceptance, and
remove or replace the assessment. An available distro package fix alone does
not mean the published upstream image contains it.

For a finding with a reachable attack path, document mitigations, an owner and a
review deadline as **risk acceptance**, not `not_affected`. An unmitigated serious
exposure blocks the affected release or feature. A private patched image is an
explicit maintenance decision when upstream updates and runtime mitigations
cannot meet the risk requirements. Unrelated application work should not acquire
an indefinite blocker solely from an already evaluated external-image finding.

References:
- [Ubuntu CVE and package fixes](https://ubuntu.com/security/CVE-2026-109518)
- [Reviewed upstream source](https://github.com/ggml-org/llama.cpp/tree/7ac5727d6037ec99c31a28c6520f45de154199d9/tools/server)
- [OpenVEX justification vocabulary](https://github.com/openvex/spec/blob/main/OPENVEX-SPEC.md)
