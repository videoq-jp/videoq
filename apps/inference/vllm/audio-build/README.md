# Artifact-only patched audio candidate

This recipe builds PyAV **19.0.2** against genuine FFmpeg **9.1** for Python 3.12,
Linux amd64, glibc 2.28+. It does not update the deployed audio lock, chart,
assessment policy or model API. No wheel has been built or approved by this
source commit. Native ABI, all codec fixtures, actual Whisper preprocessing and
independent unsuppressed security scans remain mandatory hosted gates.

## Reviewed inputs

`source-lock.json` pins the official release archive, detached signature and key,
PyAV source distribution, build-tool wheels, native test inputs and builder image.
FFmpeg's `n9.1` signed tag resolves to
`74e4393595cf2b5857f0da925c4e0dd74ea306e5`. The release archive SHA256 is
`1a4d394ae63d190a526cd052eb4415c156b5c5e2df37efab41a7de0b8fde2433`.
The release signature verifies under fingerprint
`FCF986EA15E6E293A5644F10B4322F04D67658D8`, pinned separately from its user ID.
Inputs come from FFmpeg's HTTPS release site, PyPI's official file host and
FFmpeg's native test sample hosts. Eleven CVE entries retain primary upstream
fix commit URLs, signed release file hashes and the upstream added lines found
in those files. They are verification evidence, never a scanner waiver.

The immutable manylinux builder supplies GCC/binutils/make/pkg-config/patchelf
and Python; exact reported toolchain versions accompany each build. Python
build dependencies and their transitive wheel-repair dependencies are locked
with wheel SHA256s and installed without an index or dependency resolution.
`SOURCE_DATE_EPOCH`, locale, timezone and source prefix maps are fixed. This is
a repeatable locked recipe; byte-for-byte output reproducibility still requires
a second independent hosted build comparison. Native assembly is disabled to
avoid an unpinned assembler dependency; performance suitability is unmeasured.

## Hosted CLI contract

Run from a reviewed checkout, without secrets:

```sh
python3 apps/inference/vllm/audio-build/recipe.py prepare \
  --directory "$RUNNER_TEMP/audio-context"
docker build --platform linux/amd64 --network=none \
  --file "$RUNNER_TEMP/audio-context/Dockerfile" \
  --output "type=local,dest=$RUNNER_TEMP/audio-candidate" \
  "$RUNNER_TEMP/audio-context"
```

The host needs Python 3, GnuPG and Docker BuildKit. `prepare` alone downloads
reviewed inputs, verifies exact lengths/hashes, verifies the pinned release
signer and all eleven fix-file identities, then creates a standalone context.
It refuses an existing output directory. Build RUN instructions have no network. GnuPG is used on the host by `prepare`;
the offline builder rechecks every input hash and fix file with `verify-archives`
and retains the host signature receipt, avoiding an unlocked GnuPG install.
Bound the hosted build to two make processes, job timeout and runner CPU/memory;
no registry publication is part of this recipe.

The exported root contains:

- `wheels/`: exactly one repaired `av-19.0.2-cp312-abi3-…manylinux_2_28_x86_64.whl`.
- `provenance.json`: source lock and recipe hashes, exact toolchain versions,
  wheel hash/size and every wheel member hash, including bundled ELF files.
- `source-verification.json`, `ffmpeg-config.log`, `ffmpeg-config.h`,
  `ffmpeg-config.mak`, `auditwheel.txt`, `build-smoke.json`.
- `verify.py`, `source-lock.json`, `fixtures/`: standalone native test interface.

The builder installs the repaired wheel, removes the original FFmpeg prefix
from library lookup and executes the native smoke with no loader override.
A missing bundled ELF dependency must fail rather than silently use build libs.
The source lock and resulting wheel version are truthful: PyAV remains 19.0.2,
FFmpeg reports 9.1. Do not rename an old library to simulate this result.

For deployment-image verification, D constructs a fresh disposable overlay from
this one wheel, original locked non-av dependencies and the unchanged trusted
startup guard. Never overlay this wheel over old `av`/`av.libs` contents. In the
exact pinned vLLM image, mount the candidate artifact read-only and use:

```sh
python3 /candidate/verify.py --output /writable/native-smoke.json --serving
```

Keep the existing no-network/non-root/three-native-mask execution conditions.
The output receipt is exclusive-created and retained even on failure. The
verifier checks installed member hashes and every loaded FFmpeg mapping against
the candidate wheel; unknown same-directory libraries, missing files, external
copies or hash changes fail. It invokes native registry APIs to require only
file/pipe protocols, zero output muxers/encoders, four supported decoders, and
fixed audio resampling filters. FFmpeg's unconditional video buffer source/sink
API nodes may exist, but video processing filters cannot. This is stronger than
Python monkeypatching of Cython's private filter graph.

The smoke decodes and resamples PCM16 WAV, MP3 and FLAC, and `--serving` executes
the real installed vLLM Whisper preprocessing method with fixed server limits,
without weights or an engine. Installed serving-file hashes and the unchanged
adapter hash must match the reviewed sources. The codec fixtures are exact
hash-locked FFmpeg regression/sample inputs; outputs record decoded sample
counts. Non-audio payloads must be rejected. These checks do not claim model
inference, all model-specific multimodal loaders, or production performance.

Full wheel/ELF scan, source/provenance review and native receipts are required
before any lock or policy proposal. The separately masked PyNvVideoCodec copy
is unchanged and still needs its own exact mask/nonloading proof. A candidate
build failure or new scanner finding stays blocking.

## Offline tests

```sh
python3 -m unittest discover -s apps/inference/vllm/audio-build -p 'test_*.py' -v
ruff check apps/inference/vllm/audio-build/*.py
bash -n apps/inference/vllm/audio-build/build.sh
```
