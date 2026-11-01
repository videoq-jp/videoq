# SQS worker Lambda container image (linux/arm64).
FROM ghcr.io/astral-sh/uv:0.13.6@sha256:af22a52f5eafef3d78e551599d405c02df61919d18028f0cea8eda93bc9986d0 AS uv
FROM public.ecr.aws/lambda/python:3.14@sha256:51985f11b2fb1949619bda27d121f38ef7d4db64423ca6189ab1d7e632527d27 AS lambda-local

# BEGIN managed pip
ARG PIP_VERSION=26.2.2
ARG PIP_URL=https://files.pythonhosted.org/packages/3f/06/3e4420302363fbb71be3c7f35ce042f54bfca330e3e66b3a2e3c4cca579f/pip-26.2.2-py3-none-any.whl
ARG PIP_SHA256=fd7f4dfa8190e014013b9f08f3e973f4e4c26ffd179a204895533a7254813a70
RUN python -c 'import hashlib,os,pathlib,sys,urllib.request; b=urllib.request.urlopen(os.environ["PIP_URL"],timeout=60).read(); sys.exit("pip integrity mismatch") if hashlib.sha256(b).hexdigest()!=os.environ["PIP_SHA256"] else None; pathlib.Path("/tmp/pip-"+os.environ["PIP_VERSION"]+"-py3-none-any.whl").write_bytes(b)' \
    && PYTHONPATH="/tmp/pip-${PIP_VERSION}-py3-none-any.whl" python -m pip install --no-deps --no-index "/tmp/pip-${PIP_VERSION}-py3-none-any.whl" \
    && rm "/tmp/pip-${PIP_VERSION}-py3-none-any.whl" \
    && python -c 'import os,pip,sys; sys.exit(0 if pip.__version__==os.environ["PIP_VERSION"] else 1)'
# END managed pip
# AWS publishes the patch level of its managed runtime on its own schedule.
# Pin the reviewed image digest and verify the supported release line; CI also
# runs native media tests in this exact image and reports its actual patch level.
ARG PYTHON_VERSION=3.14.10
RUN python -c "import sys; print('AWS Lambda Python:', sys.version); assert sys.version_info[:2] == tuple(map(int, '${PYTHON_VERSION}'.split('.')[:2]))"
COPY --from=uv /uv /usr/local/bin/uv

# buildx sets TARGETARCH; both binaries target glibc >= 2.28 (Lambda uses 2.34).
ARG TARGETARCH=arm64
ARG FFMPEG_BUILD=autobuild-2026-09-30-13-08
ARG FFMPEG_VERSION=n9.0.2-17-g2a571b6068

# FFmpeg / ffprobe for uploaded-video audio and frame extraction.
# Pin a retained monthly BtbN build and verify the architecture-specific archive.
# These LGPL builds are linked from https://ffmpeg.org/download.html.
RUN set -eux; \
  case "${TARGETARCH}" in \
    amd64|x86_64) FFARCH=linux64; FFSHA=2d41cbea0ca1a15029b638330740f78d6f5aeb062355bf425433fc938705350a ;; \
    arm64|aarch64) FFARCH=linuxarm64; FFSHA=b8cc09200780d37801179c803f597c22440b0b06c556addd2e6a07b27475ce37 ;; \
    *) echo "unsupported TARGETARCH=${TARGETARCH}" >&2; exit 1 ;; \
  esac; \
  dnf install -y tar xz libstdc++; \
  curl -fsSL -o /tmp/ffmpeg.tar.xz \
    "https://github.com/BtbN/FFmpeg-Builds/releases/download/${FFMPEG_BUILD}/ffmpeg-${FFMPEG_VERSION}-${FFARCH}-lgpl-9.0.tar.xz"; \
  echo "${FFSHA}  /tmp/ffmpeg.tar.xz" | sha256sum -c -; \
  tar -xJf /tmp/ffmpeg.tar.xz -C /tmp; \
  cp /tmp/ffmpeg-${FFMPEG_VERSION}-${FFARCH}-lgpl-9.0/bin/ffmpeg /usr/local/bin/; \
  cp /tmp/ffmpeg-${FFMPEG_VERSION}-${FFARCH}-lgpl-9.0/bin/ffprobe /usr/local/bin/; \
  rm -rf /tmp/ffmpeg*; \
  dnf remove -y tar xz; \
  dnf clean all; \
  ffmpeg -version >/dev/null; \
  ffprobe -version >/dev/null

# Lambda base images can lag Amazon Linux security advisories.
RUN dnf upgrade -y --releasever=latest && dnf clean all

COPY pyproject.toml uv.lock README.md ./
COPY worker_python ./worker_python
COPY handler.py ./

# Resolve nothing at deploy time. Hash checking covers all transitive wheels;
# source distributions and their build/install hooks are never executed.
RUN uv export --quiet --locked --no-dev --no-emit-project --format requirements-txt --output-file /tmp/requirements.txt \
    && pip install --no-cache-dir --require-hashes --only-binary=:all: -r /tmp/requirements.txt \
    && rm /tmp/requirements.txt

# Lambda handler: handler.handler
CMD ["handler.handler"]

# Lambda supplies its Runtime API. Keep the emulator and installation tools in
# the explicit local target, but remove their unused vendored packages/binaries
# from the deployed filesystem. In particular, pip carries a separate, older
# certifi/urllib3/msgpack/setuptools vendor tree despite the application lockfile.
FROM lambda-local AS production
RUN python -m pip uninstall --yes pip \
    && rm -f /usr/local/bin/uv /usr/local/bin/aws-lambda-rie \
    && python -c 'import handler, awslambdaric, importlib.util; assert importlib.util.find_spec("pip") is None'
