# CPU inference image: zlib

Debian trixie has no fixed package for CVE-2026-76844 yet. The image builds
official zlib 1.4 with its published SHA-256, runs upstream tests, and installs
`zlib1g` version `1:1.4-0videoq1`. Package and license records remain in the
final image and SBOM. `verify_zlib.py` verifies the version loaded by Python
and ctypes, the retained package record, and zlib/gzip compression round trips.

`zlib.openvex.json` records the upstream fix for CVE-2026-76844 and
CVE-2026-85091, restricted to this exact local package on Debian 13.7
amd64/arm64. Other versions and unknown findings still fail. The existing
CPU scan config retains assessed findings and CI uploads both assessments.

References:
- [Official zlib release and checksum](https://zlib.net/)
- [Debian CVE-2026-76844 status](https://security-tracker.debian.org/tracker/CVE-2026-76844)
- [Upstream fix](https://github.com/madler/zlib/commit/df84af25dc1942490e1d1c899a07619152a46148)

# CPU inference image: SQLite

Debian trixie's SQLite 3.46.1 has no distribution fix for CVE-2026-119373.
The CPU image therefore builds the official SQLite 3.54.1 shared library,
checking the source archive against SQLite's published SHA3-256. It installs a
local `libsqlite3-0` Debian package, version `3.54.1-0videoq1`, and preserves that
package record and source/license information in the final image and SBOM.
Python's SQLite support and FTS5 remain available to inference dependencies.

`verify_sqlite.py` runs in the final distroless image. It checks the loaded
SQLite version, retained package record, FTS5 negative-rowid prefix queries,
and absence of the SQLite CLI. The build compiles only `sqlite3.c`, never
`shell.c`. The shell's `.recover` implementation affected by CVE-2026-119586
is therefore absent.

`sqlite.openvex.json` records the upstream fix for CVE-2026-119373 (released in
3.54.0) and the absent CLI code for CVE-2026-119586. It matches only the locally
built package version on Debian 13.7 amd64/arm64. Other package versions and
unknown vulnerabilities continue to fail. CI applies `sqlite-trivy.yaml` only
to the CPU image and retains its JSON report, including assessed findings,
alongside the SBOM and assessment. A passing assessed scan is not a claim of
zero raw findings. The NVIDIA image uses its separate assessment below.

References:
- [Official SQLite source and checksums](https://sqlite.org/download.html)
- [Debian CVE-2026-119373 assessment and upstream fix](https://security-tracker.debian.org/tracker/CVE-2026-119373)
- [Debian CVE-2026-119586 CLI assessment](https://security-tracker.debian.org/tracker/CVE-2026-119586)

# NVIDIA speech image assessment

The NVIDIA build upgrades APT to Ubuntu 24.04's fix for CVE-2026-109518,
`2.8.4ubuntu0.1`, or a later package version. Both package acquisition commands
disable `Acquire::Retries` before the old client is upgraded: the vendor advisory
requires non-zero retries for exploitation. `verify_apt.py` checks that both
installed amd64 APT packages meet the fixed version using Debian version ordering.

The scan database can temporarily report this fixed package as affected without
a `FixedVersion`. `apt-fixed.openvex.json` records Ubuntu's vendor-confirmed
**fixed** status for only the exact `apt` and `libapt-pkg6.0t64` package PURLs at
`2.8.4ubuntu0.1`. It is separate from the runtime applicability evaluation for
the unmodified CPU images. No older versions, other architectures, other packages
or unknown CVEs match. Complete findings, including the fixed assessment, remain
visible via `show-suppressed`. Review this record on image/package changes and
remove it when the scanner's vendor metadata recognizes the fix.

Reference: [Ubuntu CVE-2026-109518 status and prerequisites](https://ubuntu.com/security/CVE-2026-109518).

The image keeps the C/UAPI headers needed by Triton's runtime JIT. These headers
are not a Linux kernel. The build runs `verify_kernel_headers.py`: every regular
file owned by `linux-libc-dev` must be a header or its documentation, none may be
ELF or a kernel module, and the image may contain no kernel binaries/modules.
Do not remove package metadata or retain untracked headers to change scan results.

`kernel-headers.openvex.json` lists the 386 kernel implementation CVEs reported on
this package by CI run 39954013361 on 2026-10-23. The assessment is restricted to
Ubuntu 24.04 amd64 `linux-libc-dev` version `6.8.0-147.147`, with explicit vulnerability IDs and the
`vulnerable_code_not_present` justification. It does not apply to host kernels,
other packages, unknown CVEs, or another distribution/architecture. A new package version does not match this assessment and requires a fresh
review. A changed package inventory also fails the image build instead of
silently accepting executable code under the assessment.

The image separately updates its Ubuntu packages, certifi, msgpack, pyasn1 and urllib3,
and removes pip/uv after installing audio support. Removing pip also removes
its vulnerable vendored copies; changing only the top-level dependencies would
leave those copies in the image. Runtime package records are preserved.

CI applies `trivy.yaml` only to this NVIDIA speech image. HIGH/CRITICAL findings,
including unfixed ones, still fail unless covered by the explicit assessment.
The JSON report uses `show-suppressed`, so both outstanding and assessed findings
remain available in the `whisper-vllm-security` artifact alongside this directory.
Never describe an assessed passing result as zero raw findings.

From the repository root, after building the image:

```sh
trivy image --scanners vuln --severity HIGH,CRITICAL --exit-code 1 \
  --config apps/inference/whisper/security/trivy.yaml \
  --format json --output whisper-vllm-security.json YOUR_PRIVATE_ENGINE_IMAGE
```

To obtain the unassessed report, omit `--config` and use a different output path.
Before promoting an image, retain both the report and the exact image digest.
Assess and patch the actual Kubernetes host kernel independently during site
acceptance; its state cannot be established by scanning the container's headers.

References:
- [Trivy maintainer explanation of kernel header findings](https://github.com/aquasecurity/trivy/discussions/6562)
- [Trivy OpenVEX and package URL matching](https://trivy.dev/docs/latest/supply-chain/vex/file/)
- [Example Ubuntu kernel implementation advisory](https://ubuntu.com/security/CVE-2026-63825)
- [Triton runtime compilation](https://github.com/triton-lang/triton/blob/v3.8.0/third_party/nvidia/backend/driver.py)
