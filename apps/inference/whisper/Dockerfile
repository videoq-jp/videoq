FROM ghcr.io/astral-sh/uv:0.13.6@sha256:af22a52f5eafef3d78e551599d405c02df61919d18028f0cea8eda93bc9986d0 AS uv
FROM python:3.12.16-slim-trixie@sha256:8523d6abeb48ceae0b7240d30c5808fc26cb79c1a635bacdf19cf3baecfbec07 AS native
# Only VideoQ audio preprocessing lives here; whisper.cpp runs in its upstream image.
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates xz-utils && rm -rf /var/lib/apt/lists/*
ARG TARGETARCH
ARG FFMPEG_BUILD=autobuild-2026-09-30-13-08
ARG FFMPEG_VERSION=n9.0.2-17-g2a571b6068
RUN set -eu; \
    case "$TARGETARCH" in \
      amd64) archive_arch=linux64; archive_sha=2d41cbea0ca1a15029b638330740f78d6f5aeb062355bf425433fc938705350a ;; \
      arm64) archive_arch=linuxarm64; archive_sha=b8cc09200780d37801179c803f597c22440b0b06c556addd2e6a07b27475ce37 ;; \
      *) exit 1 ;; \
    esac; \
    curl -fsSL "https://github.com/BtbN/FFmpeg-Builds/releases/download/${FFMPEG_BUILD}/ffmpeg-${FFMPEG_VERSION}-${archive_arch}-lgpl-9.0.tar.xz" -o /tmp/ffmpeg.tar.xz; \
    echo "$archive_sha  /tmp/ffmpeg.tar.xz" | sha256sum -c -; \
    mkdir /ffmpeg; tar -xJf /tmp/ffmpeg.tar.xz --strip-components=1 -C /ffmpeg

FROM python:3.12.16-slim-trixie@sha256:8523d6abeb48ceae0b7240d30c5808fc26cb79c1a635bacdf19cf3baecfbec07 AS dependencies
COPY --from=uv /uv /usr/local/bin/uv
RUN apt-get update && apt-get install -y --no-install-recommends libgomp1 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY pyproject.toml uv.lock ./
RUN uv sync --locked --no-dev && python -m pip uninstall --yes pip && rm /usr/local/bin/uv
# Distroless already contains libc/libstdc++. Record every added native library.
RUN python - <<'PY'
import pathlib, shutil, sysconfig
root = pathlib.Path('/extra')
libraries, status, licenses = (root / name for name in ('lib', 'status.d', 'licenses'))
for directory in (libraries, status, licenses): directory.mkdir(parents=True)
packages = {'libbz2-1.0': 'libbz2.so.1.0', 'liblzma5': 'liblzma.so.5',
            'libffi8': 'libffi.so.8', 'libsqlite3-0': 'libsqlite3.so.0',
            'zlib1g': 'libz.so.1', 'libgomp1': 'libgomp.so.1'}
records = pathlib.Path('/var/lib/dpkg/status').read_text().split('\n\n')
libdir = pathlib.Path('/usr/lib') / sysconfig.get_config_var('MULTIARCH')
for package, soname in packages.items():
    shutil.copyfile(libdir / soname, libraries / soname)
    record = next(record for record in records if f'Package: {package}\n' in record)
    (status / package).write_text(record + '\n')
    shutil.copyfile(f'/usr/share/doc/{package}/copyright', licenses / f'{package}.copyright')
for pattern in ('readline*.so', '_uuid*.so', '_tkinter*.so'):
    for module in pathlib.Path('/usr/local/lib/python3.12/lib-dynload').glob(pattern): module.unlink()
PY

FROM gcr.io/distroless/cc-debian13:nonroot@sha256:08476c244888bfb425bae1ae4dd7c17f093e972aab8426883d97f3c6f280f7c1
COPY --from=dependencies /usr/local /usr/local
COPY --from=dependencies /extra/lib/ /usr/local/lib/
COPY --from=dependencies /extra/status.d/ /var/lib/dpkg/status.d/
COPY --from=dependencies /extra/licenses/ /usr/share/doc/videoq-native/
COPY --from=dependencies /app/.venv /app/.venv
COPY --from=native /ffmpeg/bin/ffmpeg /usr/local/bin/ffmpeg
COPY --from=native /ffmpeg/doc/ /usr/share/doc/ffmpeg/
WORKDIR /app
COPY LICENSE /usr/share/licenses/videoq/LICENSE
COPY server.py provision.py embedding_server.py ./
USER 10001:10001
ENV PATH="/app/.venv/bin:/usr/local/bin:$PATH" PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 \
    HOME=/tmp HF_HUB_OFFLINE=1 HF_HUB_DISABLE_TELEMETRY=1 DO_NOT_TRACK=1 LD_LIBRARY_PATH=/usr/local/lib
ENTRYPOINT []
EXPOSE 8080
CMD ["python", "-m", "uvicorn", "server:app", "--host", "0.0.0.0", "--port", "8080", "--no-access-log"]
