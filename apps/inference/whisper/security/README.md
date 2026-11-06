# CPU inference image: zlib

The CPU gateway replaces Debian trixie's vulnerable zlib 1.3.1 with the official
zlib 1.4 release. The source SHA-256 is pinned to the checksum published by
zlib.net. `build-zlib.sh` builds the shared `libz.so.1` ABI and requires upstream
`make check` and a failed-write/retry regression to pass before packaging it as
`zlib1g` version `1:1.4-0videoq1`. The regression releases the caller's input
mapping after a failed `gzwrite()` to `/dev/full`, clears the error and retries;
the library must not retain or access that released buffer.

The final image retains the Debian package record, upstream license and source
checksum. It does not ship zlib contrib libraries, test binaries or build tools.
`verify_zlib.py` checks the library actually loaded by Python and by `ctypes`,
the retained package/source records, and zlib/gzip/ZIP round trips in the final
distroless image. This replacement concerns the dynamic library used by Python;
separately distributed upstream engines and FFmpeg retain their own provenance.
On ARM64, the same regression exits with SIGSEGV against the original Debian
1.3.1 library and succeeds against the source-built 1.4 library.

The current Debian scanner metadata still reports the locally built 1.4 package
as affected without a distribution `FixedVersion`. `zlib.openvex.json` records
the upstream-confirmed fix for CVE-2026-76844 for only this exact source-built
package, epoch, Debian version and amd64/arm64 architectures. It does not cover
older or unknown versions, other packages or unknown CVEs. `cpu-trivy.yaml`
retains the complete findings with `show-suppressed`; a passing assessed scan
does not mean there are zero raw findings. Reassess on source/package changes.

References:
- [zlib 1.4 release and checksums](https://zlib.net/)
- [Debian CVE-2026-76844 status](https://security-tracker.debian.org/tracker/CVE-2026-76844)
- [Upstream fixing commit, also addressing CVE-2026-85091](https://github.com/madler/zlib/commit/df84af25dc1942490e1d1c899a07619152a46148)

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
unknown vulnerabilities continue to fail. CI and release builds apply
`cpu-trivy.yaml` only to the CPU image and retain its JSON report, including assessed findings,
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
file owned by `linux-libc-dev` must be a `.h` header or its documentation, none may
be executable, a symlink, ELF or a kernel module, and the image may contain no
kernel binaries/modules.
Do not remove package metadata or retain untracked headers to change scan results.

`kernel-headers.openvex.json` lists the 386 kernel implementation CVEs reported on
this package by CI run 39954013361 on 2026-10-23. The assessment is restricted to
Ubuntu 24.04 amd64 `linux-libc-dev` version `6.8.0-147.147`, with explicit vulnerability IDs and the
`vulnerable_code_not_present` justification. It does not apply to host kernels,
other packages, unknown CVEs, or another distribution/architecture. A new package version does not match this assessment and requires a fresh
review. A changed package inventory also fails the image build instead of
silently accepting executable code under the assessment.

CI run [42172398270](https://github.com/videoq-jp/videoq/actions/runs/42172398270)
on 2026-11-06 installed Ubuntu's `6.8.0-149.149` and reported 385 of those same
explicit CVEs, with no new vulnerability IDs or findings on other packages. The
build inventory check passed for 990 files. A separate review downloaded the
official amd64 package and matched its size and SHA-256 against Ubuntu's
`noble-updates/main/binary-amd64/Packages.xz` metadata:
`e4b7b9c5023ba727908868661e1113d28ed9b68e47aed00e314723dad4b2b31d`.
The extracted package has 988 `.h` headers and two documentation files, no
executable files, symlinks, ELF, kernel modules or other include files. VEX
version 2 adds the exact `6.8.0-149.149` amd64 Ubuntu 24.04 PURL only to the 385
already-reviewed IDs actually observed in that run. The remaining statement
still applies only to `6.8.0-147.147`. Other versions and unknown CVEs continue
to fail; this is not a host-kernel assessment.

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
