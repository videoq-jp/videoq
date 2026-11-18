FROM cgr.dev/chainguard/wolfi-base:latest@sha256:2c12da5496e21e99003b3db3b9246f025e53d533c4df334205391260f1e8f85b AS ffmpeg-build
RUN apk add --no-cache build-base nasm curl xz zlib-dev lame-dev
ARG FFMPEG_VERSION=9.0.2
ARG FFMPEG_SHA256=8c3850283eb25fa026482078a04051e0be17347b09ef81a0849bec15a96e002e
RUN curl -fsSL "https://ffmpeg.org/releases/ffmpeg-${FFMPEG_VERSION}.tar.xz" -o /tmp/ffmpeg.tar.xz \
    && echo "$FFMPEG_SHA256  /tmp/ffmpeg.tar.xz" | sha256sum -c - \
    && tar -xJf /tmp/ffmpeg.tar.xz -C /tmp \
    && cd "/tmp/ffmpeg-${FFMPEG_VERSION}" \
    && ./configure --prefix=/opt/ffmpeg --disable-autodetect --disable-doc --disable-debug \
       --disable-ffplay --disable-network --disable-demuxer=rtsp --disable-protocols \
       --enable-protocol=file,pipe --enable-libmp3lame --enable-zlib --disable-shared --enable-static --enable-small \
    && make -j2 && make install \
    && mkdir -p /opt/ffmpeg/share/doc \
    && cp COPYING.LGPLv2.1 /opt/ffmpeg/share/doc/LICENSE \
    && printf 'Source: https://ffmpeg.org/releases/ffmpeg-%s.tar.xz\nSHA256: %s\n' "$FFMPEG_VERSION" "$FFMPEG_SHA256" > /opt/ffmpeg/share/doc/source

RUN test ! -e "/tmp/ffmpeg-${FFMPEG_VERSION}/libavformat/rtsp.o"

FROM ghcr.io/astral-sh/uv:0.13.9@sha256:d3b601f0c7b118bc1753febf7c41cc80981df678445e0254284eecf84db79a7d AS uv
FROM python:3.12.16-slim-trixie@sha256:5e2bdb1b0d542d5039cffb8181c65930093949194a65c365dfb1b0fe13a4fa5b AS dependencies
COPY --from=uv /uv /usr/local/bin/uv
WORKDIR /app
COPY pyproject.toml uv.lock ./
RUN uv sync --locked --no-dev && python -m pip uninstall --yes pip && rm /usr/local/bin/uv
RUN rm -f /usr/local/lib/python3.12/lib-dynload/readline*.so /usr/local/lib/python3.12/lib-dynload/_uuid*.so /usr/local/lib/python3.12/lib-dynload/_tkinter*.so

FROM cgr.dev/chainguard/wolfi-base:latest@sha256:2c12da5496e21e99003b3db3b9246f025e53d533c4df334205391260f1e8f85b
RUN apk add --no-cache python-3.12 zlib sqlite-libs libstdc++ libgomp lame-libs \
    && mkdir -p /usr/local/bin \
    && ln -s /usr/bin/python3.12 /usr/local/bin/python \
    && ln -s /usr/bin/python3.12 /usr/local/bin/python3 \
    && ln -s /usr/bin/python3.12 /usr/local/bin/python3.12 \
    && rm -f /bin/busybox /usr/bin/busybox /sbin/apk /usr/bin/apk
COPY --from=dependencies /app/.venv /app/.venv
COPY --from=ffmpeg-build /opt/ffmpeg/bin/ /usr/local/bin/
COPY --from=ffmpeg-build /opt/ffmpeg/share/doc/ /usr/share/doc/videoq-ffmpeg/
WORKDIR /app
COPY LICENSE /usr/share/licenses/videoq/LICENSE
COPY server.py provision.py provision_audio.py audio_guard.py ./
COPY security/verify_sqlite.py /app/verify_sqlite.py
COPY security/fts5-secure-delete.db /app/fts5-secure-delete.db
COPY security/verify_zlib.py /app/verify_zlib.py
COPY security/verify_ffmpeg.py /app/verify_ffmpeg.py
USER 10001:10001
ENV PATH="/app/.venv/bin:/usr/local/bin:$PATH" PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 \
    HOME=/tmp HF_HUB_OFFLINE=1 HF_HUB_DISABLE_TELEMETRY=1 DO_NOT_TRACK=1
RUN ["/usr/local/bin/python", "/app/verify_sqlite.py"]
RUN ["/usr/local/bin/python", "/app/verify_zlib.py"]
RUN ["/usr/local/bin/python", "/app/verify_ffmpeg.py"]
ENTRYPOINT []
EXPOSE 8080
CMD ["python", "-m", "uvicorn", "server:app", "--host", "0.0.0.0", "--port", "8080", "--no-access-log"]
