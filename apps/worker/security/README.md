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

# On-premises native dependencies

The on-prem worker uses a digest-pinned Wolfi serving runtime and its maintained
Python 3.14, SQLite, zlib and C/C++ libraries. Locked wheels are prepared in a
separate canonical Python build stage. Pip, uv and compilers are not shipped.

FFmpeg 9.0.2 is built from checksum-pinned official source. It retains file/pipe
and HTTP(S)/TCP/TLS for the existing object-storage range reads, and LAME for MP3
output. RTSP/SDP/RTP demuxers and RTSP/RTP muxers are disabled. The build requires
`libavformat/rtsp.o` to be absent, so the vulnerable RTSP redirect implementation
is not linked. The final-image check exercises WAV, MP3 and PNG output and checks
the actual binary configuration and protocol/demuxer inventories. The exact
FFmpeg 9.0.2 / CVE-2026-107696 assessment retains the raw finding and expires with
the worker policy on 2026-12-05. Other CVEs or versions remain blocking.

Operations scans the image actually deployed without these build-specific VEX
rules: an older deployed image may not contain the runtime guard. Its binary
findings remain visible until remediation is deployed and verified.

## Periodic production inspection

Operations resolves the immutable image actually running in Lambda. Before
applying the FIPS-only production assessment it pulls that digest, checks the
ARM64 identity and reviewed guard/handler source hashes, and runs a networkless,
read-only, non-root probe. The affected Python version must reject forced FIPS
at guard, handler import and invocation. A missing guard, source mismatch or
expired assessment fails the check. The runtime receipt and unsuppressed
Syft/Grype inventory are retained; evaluated findings remain visible in the
summary. The broader FFmpeg assessment is not applied by this production policy.
