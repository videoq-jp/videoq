# Audio gateway runtime security

The CPU gateway uses a digest-pinned Wolfi runtime with maintained Python 3.12,
SQLite 3.54.1, zlib 1.4, glibc and C++ runtime packages. Build tools and pip are
absent from the serving image; its shell and package-manager executables are
removed. It runs as numeric UID 10001 with a read-only root in the chart.

`verify_sqlite.py` checks the actual loaded version, package record, absence of
the SQLite CLI, FTS5 negative-rowid prefix queries and the upstream secure-delete
corruption regression. `verify_zlib.py` checks both Python and ctypes library
versions plus zlib/gzip/ZIP round trips.

FFmpeg 9.0.2 is built from the SHA-256-pinned official source with networking and
RTSP disabled and only file/pipe protocols. The build requires the vulnerable
`libavformat/rtsp.o` object to be absent. The final-image `verify_ffmpeg.py`
checks its configuration, protocol/demuxer inventories and WAV/PNG output.
`cpu-grype.json` applies only the exact FFmpeg 9.0.2 / CVE-2026-107696 assessment;
raw Grype findings remain in retained evidence. New CVEs and package versions
still block. The assessment expires on 2026-12-05.

The earlier Debian source-build helpers and SQLite/zlib VEX records in this
folder are retained for reproducing historical releases. They are no longer
used by the current Dockerfile or Grype policy.

- [SQLite releases](https://sqlite.org/changes.html)
- [zlib releases](https://zlib.net/)
- [FFmpeg releases](https://ffmpeg.org/download.html)
- [CVE-2026-107696](https://security-tracker.debian.org/tracker/CVE-2026-107696)

# Upstream NVIDIA inference inspection

The upstream vLLM image remains digest-pinned and unmodified. Its complete raw
scan is assessed separately against the exact serving configuration, runtime
imports, read-only native-library masks and the hash-locked local-audio guard.
See [the vLLM runtime assessment](../../vllm/security/README.md).
