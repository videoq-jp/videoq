# Exact CPU gateway library assessments

The image builds upstream SQLite 3.54.1 and zlib 1.4 from checksum-pinned sources.
Distribution scanners cannot infer these local replacements from Debian's
unfixed trixie package metadata. OpenVEX statements cover only the listed CVEs
and exact amd64/arm64 package URLs; other versions and findings remain blocking.
The HIGH/CRITICAL scan, unfixed findings and suppressed-finding visibility stay on.

- [CVE-2026-119374](https://security-tracker.debian.org/tracker/CVE-2026-119374):
  Debian identifies upstream secure-delete bounds fix
  `d9de6eedbe918c074c7556400fa21df5960704d9` in SQLite 3.54.0. The image uses
  3.54.1. Its final-image verifier also runs the vendor's malformed-index
  regression in autocommit mode and requires `SQLITE_CORRUPT`, preserving FTS5
  support. Autocommit matches the upstream Tcl test and includes the FTS5
  transaction flush in the checked statement; a deferred Python transaction
  would return from `execute()` before that flush.
- [CVE-2026-119379](https://security-tracker.debian.org/tracker/CVE-2026-119379):
  the vulnerable changeset path belongs to SQLite's optional session extension.
  This library does not compile it. The final-image verifier requires the
  `ENABLE_SESSION` compile option and session/changeset entry-point symbols to be
  absent. Adding that extension invalidates this assessment and fails the build.
- [CVE-2026-85091](https://security-tracker.debian.org/tracker/CVE-2026-85091):
  upstream zlib fix `df84af25dc1942490e1d1c899a07619152a46148` is in 1.4. The
  source build requires upstream tests and a write-failure/retry regression,
  including `gzprintf` after releasing the original caller buffer. The final
  image verifies the loaded 1.4 library and its packaged source identity.

`fts5-secure-delete.db` is a **public upstream regression fixture**, not an
application database or user backup. It reconstructs the 5120-byte hex database
from cases 4.0/4.1 of SQLite's
[fts5corruptB.test at the fix commit](https://github.com/sqlite/sqlite/blob/d9de6eedbe918c074c7556400fa21df5960704d9/ext/fts5/test/fts5corruptB.test).
Fixture SHA-256:
`6403bc6c08deee687c69e6d05c680a443f7d994bda19071131db0bd196538fa3`.
The upstream test source SHA-256 is
`c61e04d19c636f96552163fec66384d41d1f2052b8184eb716a219f799069d92`.
SQLite source and tests are [public domain](https://sqlite.org/copyright.html).

The original scan evidence is CI run `42326108951`, on-prem job `128261811939`,
artifact `13555728482`. Its three affected findings are the exact additional
assessments above. Version/provenance/runtime checks establish the assessments;
the scan must still pass after they are applied.
