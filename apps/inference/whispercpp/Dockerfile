# Exact upstream ELF provenance; native platform is selected by the hosted matrix.
ARG UPSTREAM_IMAGE=ghcr.io/ggml-org/whisper.cpp@sha256:0b39b82d8febd2708a5abd2e3d8d373620604d558922f2cf921b7f4c365e6c73
FROM ${UPSTREAM_IMAGE} AS upstream

FROM cgr.dev/chainguard/wolfi-base:latest@sha256:b71197549d072ad4f359219953cb065745604010f24d884d75ab46d651da9a0b AS assembled
ARG TARGETARCH
ARG UPSTREAM_IMAGE
RUN case "$TARGETARCH:$UPSTREAM_IMAGE" in \
      amd64:ghcr.io/ggml-org/whisper.cpp@sha256:0b39b82d8febd2708a5abd2e3d8d373620604d558922f2cf921b7f4c365e6c73|\
      arm64:ghcr.io/ggml-org/whisper.cpp@sha256:f0fed3d3d54565cb37d2995fcaa28ca09a5c9f3ffb7fada2d790099af2bfeee0) ;; \
      *) echo 'Unapproved upstream platform/digest' >&2; exit 1 ;; \
    esac \
    && apk add --no-cache libstdc++ libgomp
COPY --from=upstream /app/build/bin/whisper-server /app/build/bin/whisper-server
COPY --from=upstream /app/build/bin/*.so* /app/build/bin/
COPY --from=upstream /app/LICENSE /usr/share/licenses/whispercpp/LICENSE
COPY apps/inference/whispercpp/provenance.json /usr/share/doc/videoq-whispercpp/provenance.json
ENV LD_LIBRARY_PATH=/app/build/bin
# Loader tracing proves the final executable's runtime closure, without adding
# inspection/development packages. Saved output is provenance, not a VEX waiver.
RUN mkdir -p /usr/share/doc/videoq-whispercpp \
    && LD_TRACE_LOADED_OBJECTS=1 /app/build/bin/whisper-server > /usr/share/doc/videoq-whispercpp/linked-libraries.txt \
    && ! grep -q 'not found' /usr/share/doc/videoq-whispercpp/linked-libraries.txt \
    && /app/build/bin/whisper-server --help > /usr/share/doc/videoq-whispercpp/help.txt 2>&1 \
    && grep -q -- '--model' /usr/share/doc/videoq-whispercpp/help.txt

# Build this target to retain shell tools solely for hosted diagnostic inspection.
FROM assembled AS verify
CMD ["/app/build/bin/whisper-server", "--help"]

FROM assembled AS runtime
ARG UPSTREAM_IMAGE
LABEL org.opencontainers.image.source="https://github.com/videoq-jp/videoq" \
      io.videoq.whisper.upstream.image="${UPSTREAM_IMAGE}"
# Remove packages, rather than deleting their files while leaving false SBOM
# records. No source, development headers, build tools, models or apt are copied.
# Wolfi baselayout may own compatibility symlinks separately from the packages.
# Keep a transient cleanup executable within this single layer, remove those
# tool links after uninstall, then remove the cleanup executable itself.
RUN cp "$(command -v busybox)" /tmp/runtime-cleanup \
    && apk del --purge busybox apk-tools \
    && /tmp/runtime-cleanup rm -f /usr/bin/apk /sbin/apk /bin/sh /bin/ash /bin/bash /bin/busybox /usr/bin/busybox /tmp/runtime-cleanup
WORKDIR /app
USER 10001:10001
ENTRYPOINT ["/app/build/bin/whisper-server"]
CMD ["--help"]
