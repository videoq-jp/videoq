## 2026-11-20 extension and enforced codec contract

The new raw scan adds 173 Linux implementation findings and 33 FFmpeg findings
in already-masked native directories. Each Linux CNA record was fetched from
pinned CVEProject commit metadata, hashed and checked for affected program files:
all 173 list kernel implementation/internal-header paths, none exported UAPI.
The exact image/header inventory and absence of kernel modules remain required;
this does not assess the host kernel. Records are in `kernel-cve-review.json`.

The read-only audio overlay also contains FFmpeg 9.0.2 findings in encoders,
video paths and unsupported decoders. PyAV 19.0.2 is still the latest upstream
wheel at this review; these packages are not claimed patched. The v2 hash-locked
guard now forces both demuxer **and decoder** whitelists, permits read mode only,
and rejects unsupported stream codecs before caller decoding. Allowed codecs
are only `mp3`, `mp3float`, `pcm_s16le` and `flac`. This closes the ambiguity that
WAV can carry codecs other than PCM. The private gateway sends PCM16 WAV to
Whisper. Other WAV subtypes must be normalized by the gateway, not passed directly.

The 29 additional overlay assessments require fresh actual-image proof of guard
identity, successful supported decoding, RTSP rejection and rejection of a real
A-law WAV input, plus the exact allowed-codec list. The scanner, raw findings,
package identities, locations, mandatory mounts and existing expiry are retained.
`native-codec-cve-review.json` records the pinned primary CNA sources/hashes and
FFmpeg references. A missing/changed proof is blocking. This is configuration
mitigation for fixed VideoQ services, not a blanket FFmpeg or vLLM approval.

# Upstream vLLM applicability review

## Enforced native-library isolation and local audio

Grype catalogs native FFmpeg libraries and Go components embedded in Mooncake
that were not represented by the earlier scan. The chart now mounts empty,
read-only directories over PyNvVideoCodec, OpenCV's bundled native libraries and
Mooncake. Their code is absent from the serving filesystem namespace. These
profiles do not support video inputs or Mooncake KV transfer. The assessment
requires exact package/CVE/PURL/file locations, every mandatory mount, no other
container that can write the mask volume, and an actual-image probe proving the
directories are empty and read-only. Findings remain visible in the raw scan.

The audio volume also contains a trusted `sitecustomize.py`, copied only from
`audio_guard.py` after its hash is checked against the wheel manifest. It rejects
network URLs and custom I/O callbacks and forces PyAV protocols/formats to local
MP3/WAV/FLAC, covering the RTSP redirect path in CVE-2026-107696. A runtime proof
must verify the loaded guard hash, rejection before network I/O and successful
WAV decoding. A changed guard, writable/missing mount, library location, CVE or
package version prevents the corresponding assessment. No upstream patch or
zero-raw-findings claim is made. The existing short expiry still applies.

Historical counts and verification records below describe their original scans.

VideoQ uses the unmodified `vllm/vllm-openai` v0.33.0 Linux amd64 image, pinned
by its platform digest in the inference chart. No VideoQ vLLM image is built or
published. Four upstream audio wheels and patched dnspython 2.9.2 are locked by URL, version, size and SHA-256
in the chart's `files/vllm-audio-wheels.json`; setup verifies and extracts them on
a separate volume. No installer, dependency resolver or source build runs in the
serving image. Runtime mounts the audio volume and model weights read-only.

## Findings remain visible

The 2026-11-15 raw scan contains 640 HIGH/CRITICAL findings, including 179 newly
reviewed kernel findings and CVE-2026-128089 in the base dnspython 2.9.1. The 179
Linux CNA records and their source hashes are retained in `kernel-cve-review.json`.
The base DNS finding remains visible: acceptance requires a fresh actual-image
probe proving that the locked 2.9.2 wheel resolves from `/opt/videoq-audio` and
rejects the upstream bounded WKS reproducer. Missing, stale or failed runtime
evidence does not pass. The previous four-wheel runtime proof is historical and
does not prove the new five-wheel configuration.

The current five-wheel image probe passed in
[CI run 43615358433](https://github.com/videoq-jp/videoq/actions/runs/43615358433),
artifact 14121732864, source commit `8f16b6664a5e6118b733782a98aa4800385df375`.
Its JSON confirms dnspython 2.9.2 at `/opt/videoq-audio/dns/__init__.py`, rejection
of the bounded out-of-range WKS input, all five locked distributions, and no
unassessed image or blocking overlay findings. This is actual-image CPU/import
verification; the earlier GPU inference evidence remains historical.

A passing applicability
check is not a claim that the upstream packages are patched or that the raw scan
is empty. `runtime-assessment.json` permits only the exact listed CVE/package/PURL
combinations, after verifying actual image files and all ten rendered deployment
variants (five NVIDIA profiles, including the shared RTX 4090 profiles,
with downloads enabled and disabled).

| Finding scope | Raw count | Evidence and applicability |
|---|---:|---|
| Linux implementation CVEs attributed to `linux-libc-dev` | 618 | The image contains 990 verified non-executable UAPI header/documentation files, and no kernel binaries/modules. Their sorted paths, modes and SHA-256 values must match the reviewed aggregate. The 233 additions after the original assessment were checked against Linux CNA affected program files; the records are in `kernel-cve-review.json`. This does not assess the host kernel. |
| APT acquisition | 2 | Serving does not perform package acquisition. Setup runs in the separate gateway image, and the serving filesystem is read-only under UID 10001. |
| GnuPG ASCII-armor parser | 10 | The fixed model-serving commands do not invoke GnuPG or process OpenPGP messages. |
| OpenSSL PKCS#7 verification / DTLS retransmission | 4 | These operations are not provided by the reviewed HTTP model endpoints or uploaded-audio decoder. Ordinary HTTPS TLS is not DTLS or PKCS#7 verification. |
| pip's vendored installer dependencies | 5 | Image-layer inspection identifies `pip/_vendor/bom.cdx.json`. Native package resolution outside that directory selects msgpack 1.2.4, setuptools 80.10.2 and urllib3 2.8.0 for serving. Audio setup extracts locked wheels without invoking pip, downloading installer caches or executing setup.py. Interactive/build uses are excluded. |
| dnspython WKS zone-text parser | 1 | Vulnerable 2.9.1 remains in the immutable image. The serving runtime must instead import fixed 2.9.2 from the hash-locked read-only overlay; the actual-image parser probe and its matching lock are mandatory. |

Primary references:

- [Ubuntu UAPI header package](https://packages.ubuntu.com/noble/linux-libc-dev)
- [APT advisory](https://ubuntu.com/security/CVE-2026-109518)
- [GnuPG armor parser advisory](https://dev.gnupg.org/T7906.html)
- [OpenSSL PKCS#7 advisory](https://openssl-library.org/news/secadv/20260609.txt)
- [OpenSSL DTLS advisory](https://openssl-library.org/news/secadv/20260929.txt)
- [pip's vendored libraries](https://github.com/pypa/pip/tree/main/src/pip/_vendor)

## Enforcement

`.github/workflows/upstream-vllm.yml` retains the unsuppressed image scan, installed
audio-volume scan, exact-image inventory, runtime import/codec checks and evaluated
findings. Grype collects the report first; the following evaluator fails on any
unreviewed HIGH/CRITICAL/UNKNOWN finding. Raw findings are never removed by VEX or
an ignore file. Missing inventories, changed file hashes, changed runtime package
versions, writable roots, altered commands/hooks, writable model/audio mounts and
expired assessments all fail closed. The EmbeddingGemma 2 runtime also requires
the reviewed `TORCHDYNAMO_DISABLE=1` setting alongside eager mode. This is
[PyTorch's upstream runtime switch](https://github.com/pytorch/pytorch/blob/v2.14.0/torch/_dynamo/eval_frame.py),
not an engine source change. Each audio scan must contain exactly the
five locked installed distributions and match the provisioning receipt. The
applicability evaluator additionally binds the runtime probe source hash and
rejects fallback to the old base DNS module, wrong versions, failed range checks,
and evidence from an earlier overlay lock. No arbitrary CVEs in dnspython are
covered by this exact finding review.

This evaluation covers only the reviewed chart workloads: numeric UID 10001,
no privilege escalation, dropped capabilities, no service-account token, fixed
local model paths and no arbitrary startup/model Python code. It does not cover
interactive package operations, other images, site overrides or the host kernel.
Reviews expire in at most 30 days. Image/model/argument/dependency changes require
fresh file and runtime verification before updating the assessment.

The inspection results and actual GPU checks are tracked in
[the verification record](../../../../docs/verification/upstream-vllm-inspection.json).

## 2026-11-26 exact kernel implementation review

`kernel-20261126-review.json` retains 75 complete primary Linux CNA records at
CVEProject commit `7e4de3c1bcb5d5a1818ac5b96c2cf5370cad98b8`, their individual
SHA-256 hashes, affected source paths and the exact 990-file native inventory.
The new group requires the exact CVE, image, package version, normalized PURL
and scanner locations. Original Grype PURLs including `upstream=linux` are
retained separately from the normalized compatibility representation.
Every listed affected path is kernel implementation or an internal header,
absent from this user-space package; internal `include/net/mptcp.h` is distinct
from exported `/usr/include/linux/mptcp.h`. There is no wildcard kernel-CVE rule.
Changes to the evidence, contents, paths, modes, commands or security contexts
invalidate acceptance. The native collector rejects symlinks, executable files,
ELF and modules; the evaluator verifies the complete hashed inventory.

The review retains the existing owner, expiry and serving restrictions. It is
neither a patched-image claim nor a host-kernel assessment. At that initial
header review, 22 new FFmpeg image/overlay findings remained blocking and
required separate review. A retained
same-image artifact can test this evaluator; final acceptance still requires a
fresh native probe and full unsuppressed scan of the immutable serving image
and audio overlay with all ten rendered workload configurations checked.

## 2026-11-26 exact masked image-library findings

`masked-ffmpeg-20261126-review.json` retains the 11 pinned primary CNA records
and their hashes, exact FFmpeg 8.1.1 image tuples and 26 locations, plus the
reviewed native inventory and complete check set from artifact `15080457487`
(run `45738439321`, source `1fbedd44`, merge `1d3a54b3`, immutable amd64 image
unchanged). This explicitly replaces the old 9.0.2 overlay proof; that complete
old proof is retained as a non-executable historical test fixture. The evaluator requires
this evidence for these exact CVEs; aliases, other versions, locations and
platforms cannot extend it. All raw HIGH/CRITICAL findings remain visible.

The observed four empty read-only masks, absent executable module imports,
26 denied absolute native loads, blocked TorchCodec decoder/core imports and
seven exact hash-verified overlay ELF mappings establish physical exclusion
of these image copies in the reviewed workloads. Every staged import/serving
mapping and normalized automatic waveform/reference check is bound to the
reviewed receipt. The existing owner, expiry, ten rendered profile gates and
kernel inventory checks remain unchanged. An incomplete or changed proof,
probe source, model command, mount or dependency requires fresh review.

The check-set comparison now pins published PyAV 19.0.2 / FFmpeg 9.1 wheel
`75fd08d2`, all 227 members, probe `ac0c165d`, lock `d3cac735` and guard
`bb523747`. All 14 native checks passed; the observed whole job still failed
at assessment because it used the previous proof. With this proposed proof,
local evaluation of that retained artifact and all ten rendered profiles accepts
979 reviewed image findings with no unassessed image finding. The audio scan
contains zero raw matches and zero ignored findings: no new audio waiver is
introduced. Historical positive/hostile tests stay isolated; the real active
evaluator rejects the old receipt and mutated current evidence. Another wheel,
probe, adapter or dependency change still requires a fresh native receipt and
explicit review. These 11 image assessments never approve overlay findings.
`nativeFilterTraceComplete=false` remains explicit: this is physical code
exclusion, not complete native filter tracing or an upstream patch claim.
The proof covers CPU imports/preprocessing, not GPU/full-model execution or the
host kernel. JSON equality is not artifact authentication: the caller must use
the protected trusted native workflow and verify its source/run provenance.

## 2026-11-27 additional findings and release recovery

Issue #1754 tracks the separate release failure at main `6ea74c9b`, run
`45966108942`, job `140395168535`, attempt 1. The unsuppressed scan added 34
`linux-libc-dev 6.8.0-147.147` CVEs and two FFmpeg 8.1.1 CVEs
(`CVE-2026-135706`, `CVE-2026-135709`). The actual audio overlay scan had zero
matches and zero ignored matches. The inventory and complete native runtime
checks passed; the job failed only at the unassessed-finding gate.

The two additional review files preserve the original 75 kernel and 11 masked
FFmpeg reviews unchanged. They retain all 36 new primary CVE JSON records and
hashes from CVEProject commit `b0cd7b5412b9aa02e40e3ab97d536b87dc57f8bc`.
The 34 kernel implementation/internal-header paths are absent from the exact
990-file user-space header inventory, including `io_uring/io-wq.c` and internal
`include/asm-generic/tlb.h`. Host-kernel applicability remains outside this
package-content review. The two FFmpeg findings have exactly the same 26 masked
locations; they require the complete current denial/mapping proof and never
approve findings in the separately scanned loaded FFmpeg 9.1 audio overlay.

Artifact `15183042431` has GitHub digest
`sha256:23d2e89ed0c1e3067562b17ee49b98560a14aaea391175ce50f6c29ea272e112`.
The downloaded ZIP matches that digest and all 19 downloaded files. Its actual
native inventory and runtime check set exactly match the existing current
proof. Replaying the retained raw scan with all ten actual Helm renders accepts
1,015 priority findings for this exact workload, with zero unassessed image or
audio findings. All 7,597 raw image matches are retained without suppression.
This replay is recorded under `additionalFindingReview20261127` in the
verification record; it is not a successful new signed release.

Changed CVEs, aliases, versions, PURLs, scanner locations, native files, mounts,
commands or proof fail closed. The additional reviews retain the existing
expiry of `2026-12-10T21:05:42.246607+00:00`; extending the global policy alone
cannot renew them. Fresh normal On-prem Release, signature/publication, staging
and CPU acceptance are tracked in #1754. Customer production promotion and
upgrades still require their operator's action.
