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
zero raw findings. Upstream NVIDIA inspection is described below.

References:
- [Official SQLite source and checksums](https://sqlite.org/download.html)
- [Debian CVE-2026-119373 assessment and upstream fix](https://security-tracker.debian.org/tracker/CVE-2026-119373)
- [Debian CVE-2026-119586 CLI assessment](https://security-tracker.debian.org/tracker/CVE-2026-119586)

# Upstream NVIDIA inference inspection

The custom NVIDIA image and its build-specific VEX assessments have been removed.
The unchanged upstream vLLM image is checked by
`.github/workflows/upstream-vllm.yml`. No former custom-image assessment applies
to its packages. Raw OS/Python findings and runtime checks are retained; unassessed
HIGH, CRITICAL and UNKNOWN findings block publication. Current candidate status
is recorded in [inspection evidence](../../../../docs/verification/upstream-vllm-inspection.json).
