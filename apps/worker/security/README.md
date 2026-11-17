# CPython FIPS applicability

CVE-2026-119170 affects only Python 3.14.10 when OpenSSL FIPS mode is enabled.
The worker rejects this combination at handler import and before each invocation.
The final image's handler import check exercises the guard. It does not disable
FIPS mode or bypass a caller's FIPS requirements: affected configurations fail.

The exact `pkg:generic/python@3.14.10` / CVE pair is assessed until 2026-12-05.
The vulnerable binary finding remains in raw Grype evidence. Other Python
versions and CVEs are not covered. Remove the guard and assessment after the
pinned AWS and on-prem base images include the upstream fix.

- https://mail.python.org/archives/list/security-announce%40python.org/message/PXVTTOBPUMFJSSUXN6XCS7FC5DZOSZXK/
- https://explore.alas.aws.amazon.com/CVE-2026-119170.html
