# Temporary OpenSSL security backports

The API and web runtime images build OpenSSL **3.5.9-r100** locally because
Alpine's published 3.5.9-r1 does not yet contain the five additional fixes below.
This is a VideoQ package revision, not an Alpine release. Replace this build with
an official package once it contains all of these fixes.

`APKBUILD`, `auxv.patch`, the FIPS install hook, and the five November 10 patches
come from Alpine aports commit
[5e6d18a5ba2eec060b34a671a43ee54a5e72714a](https://github.com/alpinelinux/aports/tree/5e6d18a5ba2eec060b34a671a43ee54a5e72714a/main/openssl).
The recipe changes only the local revision and adds these upstream OpenSSL 3.5
branch patches, with SHA-512 digests recorded in both `APKBUILD` and
`upstream-fixes.json`:

| Vulnerability | Upstream commit |
| --- | --- |
| CVE-2026-124709 | [f3acb0a3328046741479482c51cec815839e1b05](https://github.com/openssl/openssl/commit/f3acb0a3328046741479482c51cec815839e1b05) |
| CVE-2026-107493 | [c8f6d04f8e6d40b1bf83334e4a2ec9daf5943a3d](https://github.com/openssl/openssl/commit/c8f6d04f8e6d40b1bf83334e4a2ec9daf5943a3d) |
| CVE-2026-107494 | [9e6f4e45475b46622884211390648d53cf65c796](https://github.com/openssl/openssl/commit/9e6f4e45475b46622884211390648d53cf65c796) |
| CVE-2026-121482 | [468c287cf451a834b370b69ab321b8ffdfac23aa](https://github.com/openssl/openssl/commit/468c287cf451a834b370b69ab321b8ffdfac23aa) |
| CVE-2026-84786 | [a277789b720230987e5d72a978bc98b3ccef569c](https://github.com/openssl/openssl/commit/a277789b720230987e5d72a978bc98b3ccef569c) |

The published CVE records for the latter three reference OpenSSL pull requests
33544, 33546, and 33634, respectively. The first two are described in the
[November 17 upstream advisory](https://openssl-library.org/news/secadv/20261117.txt).

`abuild` verifies the source archive and every patch before applying them and
runs the upstream test suite. The build stage signs its APKs with an ephemeral
key; the final stage installs only the two library packages and their public
verification key. Compilers, source trees, and the private signing key remain in
the build stage.

`backports.openvex.json` records **fixed**, rather than ignored or not affected,
findings only for these exact locally built package identities on supported
architectures and distro versions. Unmodified packages, other revisions, and
unrelated vulnerabilities continue to fail the strict scanner gate. Raw SBOM
and scanner findings remain in the CI artifacts.
