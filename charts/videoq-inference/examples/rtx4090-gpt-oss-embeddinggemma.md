# GPT-OSS / EmbeddingGemma 2 / Whisper on one RTX 4090

This profile keeps all three model inference engines on CUDA. EmbeddingGemma
uses its task-aware sentence-transformers server (text encoder only, BF16,
batch size one), not the CPU image or a generic pooling endpoint. It fails
startup if CUDA is unavailable. Audio decoding and speech detection remain in
the transcription gateway.

Use the same three-slot NVIDIA device-plugin configuration as `rtx4090.yaml`.
The initial memory fractions are chat 0.66, embedding 0.07, speech 0.12. These
are capacity settings, not VRAM isolation: time slicing shares GPU compute and
does not partition its memory. Chat runs eagerly with one sequence, 16384-token
context, 512-token prefill batches, and no CPU weight offload.

Build `apps/inference/whisper/Dockerfile.embedding-cuda` on the Linux GPU host
and import the image into K3s containerd before installation. The example uses
`videoq-embedding-cuda:local-4090` with `pullPolicy: Never`. This local image is
not covered by the signed application release attestation; production use
requires an independently built, reviewed, digest-pinned image. Existing signed
release locks still supply the GPT/speech engine and provisioning gateway.

Both API and worker must use `EMBEDDING_PROFILE=embeddinggemma2`, the example's
embedding model alias, and its private embedding endpoint. The profile writes
to the separate 768-dimensional table. Run the corresponding application
migration before using it; existing 1536-dimensional vectors cannot be reused.

Allocate a new 20 GiB chat PVC when switching from the 10 GiB Qwen profile.
K3s local-path PVCs cannot be expanded in place. Retain old claims until their
contents are reviewed. Use a site overlay for `servers.chat.persistence.existingClaim`.

Acceptance requires three Ready Pods, an actual CUDA operation in every engine,
real query/document embeddings, chat completion, and speech transcription while
all three are resident. A successful Helm install alone does not establish fit.

Startup is serialized as Whisper → GPT-OSS → EmbeddingGemma for this profile.
The dedicated embedding server does not run a vLLM KV-cache profiler, so it can
start after both vLLM engines reserve their configured budgets.

## Measured on 2026-11-11 JST

In the initial 4K-context check on Ubuntu 22.04.5 LTS, all three Pods became Ready with zero restarts in their
final configuration. GPU usage after real requests was 20,523 / 24,564 MiB:
GPT-OSS 16,254 MiB, Whisper 3,246 MiB, and EmbeddingGemma 1,004 MiB (plus driver
overhead). Each engine passed CUDA matrix multiplication on the same GPU UUID.
Japanese query/document embeddings had 768 dimensions and ranked the relevant
document above a distractor; Japanese chat, a forced function call, and an
11-second timestamped speech transcription passed while all models remained
resident. Full VideoQ application acceptance remains separate.

Evidence: `docs/verification/rtx4090-gpt-oss-embeddinggemma-2026-11-11.json`.

The native installer now uses a 16K chat context. The follow-up check accepted
9,435 prompt tokens, returned the expected answer, and retained all three GPU
models at about 20 GiB total. Reapplying the same installer preserved Secret
data, PVC UIDs, the administrator setup record and all model Pod identities.
See `docs/verification/native-rtx4090-install-2026-11-11.json` for that evidence.
