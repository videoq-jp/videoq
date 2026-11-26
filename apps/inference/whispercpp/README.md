# Minimal whisper.cpp CPU runtime

This candidate repackages the exact already-pinned upstream server/shared ELF
bytes. It does not infer a source commit from an image tag or rebuild a different
whisper.cpp revision. `provenance.json` records both immutable source images and
the pinned runtime base; the reviewed upstream Dockerfile commit is explicitly
not claimed as a source attestation for those images.

Only `/app/build/bin/whisper-server`, its built `.so` files, and the upstream
license are copied. Wolfi supplies the dynamic loader, libc, libstdc++ and libgomp
runtime closure. The build traces the actual executable's dependencies and runs
`--help`, failing if any library is missing. It does not copy Ubuntu packages,
APT, SDL development packages, headers, compilers, CMake, git, source, or models.
The runtime explicitly retains wolfi-baselayout/OS metadata and runtime libraries, removes the empty wolfi-base metapackage that otherwise retains tool dependencies, and removes busybox and apk-tools packages and runs as UID/GID 10001.
The chart-compatible executable path stays `/app/build/bin/whisper-server`.

This source is a candidate, not a scan result or a verified published image.
Fresh native amd64 and arm64 execution and full final-image scans are mandatory.
There are no additional VEX statements, vulnerability waivers or severity changes.
Do not update chart pins from an unscanned build or from a mutable tag.

## Native hosted build interface

From the repository root, choose the source from
`provenance.json` for the runner's architecture:

```sh
architecture=amd64 # arm64 on the native arm64 runner
upstream=$(python3 -c 'import json,sys; print(json.load(open("apps/inference/whispercpp/provenance.json"))["binarySourceImages"][sys.argv[1]])' "$architecture")
docker buildx build --platform "linux/$architecture" \
  --build-arg "UPSTREAM_IMAGE=$upstream" \
  --file apps/inference/whispercpp/Dockerfile \
  --tag whispercpp-candidate --load .
python3 apps/inference/whispercpp/verify_runtime.py \
  --candidate whispercpp-candidate --architecture "$architecture" \
  --receipt runtime-receipt.json
```

D owns the hosted workflow, exact multi-exporter OCI artifact identity check,
full-image security scans, protected publisher and eventual chart/image pins.
The verifier never rebuilds or publishes. It compares each server/library hash to
the approved source image, verifies final package/file absence, and checks native
host and Docker architecture. It executes help as non-root with a read-only
filesystem, no added capabilities and no network.

For server health it extracts only the already-bundled upstream
`/app/models/ggml-base.en.bin` into disposable host storage and mounts that file
read-only. The model is not included in the final runtime. The server has a
network-none namespace; a separately pinned Python probe image shares that same
namespace and verifies the actual HTTP health endpoint after model loading, then submits a generated one-second PCM WAV through the inference endpoint and requires a successful JSON transcription response.
The helper removes only containers it creates and deletes its temporary files;
it never restarts or prunes Docker. A missing model, dependency, unhealthy server,
extra build artifact or unsupported architecture fails verification.

The receipt contains the loaded image configuration digest, upstream ELF hashes,
model hash, installed runtime package names and dynamic-loader output. It does
not confuse the local configuration digest with the final registry manifest
identity. The workflow must prove it exported/scanned the same artifact, then
retain its immutable OCI/platform digests and scans. Publishing is restricted to
`ghcr.io/videoq-jp/videoq-whispercpp-candidate` only after both native artifacts
pass. Existing application publication scopes and production deployment are not
part of this corrective verification.

## Offline checks

```sh
python3 -m unittest discover -s apps/inference/whispercpp/tests -v
```

These inventory rejection tests require no Docker daemon and do not substitute
for the native runtime and final-image scans.
