# Upstream vLLM applicability review

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
variants (five NVIDIA profiles, including the two shared RTX 4090 profiles,
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
findings. Trivy collects the report first; the following evaluator fails on any
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
