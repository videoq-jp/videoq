---
sidebar_label: Local AI inference
description: Run VideoQ chat, embeddings and Whisper inside the on-premises network.
---

# Keep AI processing on-premises

VideoQ can run chat, embeddings and Whisper on site alongside its web, API and
worker workloads. Initial container/model downloads can use the internet;
uploaded video, audio and AI requests use private services during processing.
The application Helm defaults select private local inference. Apply the paired
Gemma 4 overlays below to install the matching model services.

| Recipe | LLM / embedding runtime | Application overlay |
|---|---|---|
| NVIDIA GPUs (recommended) | Gemma 4 26B A4B, EmbeddingGemma 2 and Whisper on upstream vLLM | `local-ai-gemma4.yaml` |
| CPU | llama.cpp, separate chat / embedding APIs | `local-ai-llamacpp.yaml` |
| NVIDIA GPU | vLLM, separate chat / embedding APIs | `local-ai-vllm.yaml` |

The recommended model combination is **Gemma 4 26B A4B + EmbeddingGemma 2 + Whisper
large-v3-turbo**. Pair `charts/videoq-inference/examples/gemma4-embeddinggemma.yaml`
with `charts/videoq/examples/local-ai-gemma4.yaml`. This selects three dedicated NVIDIA GPUs
for chat, embeddings and transcription. Chat uses BF16 weights and requires a
dedicated 80 GB GPU; label its node `videoq.io/gemma4-vram=80gb` after checking
physical VRAM. All devices exposed on a labeled node must satisfy the chat VRAM
requirement; mixed GPU nodes need device isolation. Embedding and Whisper
reserve one additional GPU each. This fully resident
profile does not fit three models on a single RTX 4090; the separate
[4090 CPU-offload candidate](rtx4090.md) requires 128 GiB host RAM. The older
Qwen recipes remain explicit compatibility profiles. A small CPU-only VPS cannot
host the recommended chat service; point it at a separate private GPU server.

EmbeddingGemma 2 uses vLLM pooling. Queries use the model's
`SearchQuery` prompt and indexed subtitle scenes use `Document`; both return
normalized 768-dimensional vectors. `ai.embeddingProfile: embeddinggemma2`
selects this contract in **both API and worker**. The application prepends the
model's task prefix to ordinary OpenAI embedding input; no custom API is required.

Take a database/configuration backup and pause uploads, transcript edits and
search during migration. Apply database migrations before starting the new app. The additive migration
creates `scene_embeddings_768`, leaving the existing 1536-dimensional
`scene_embeddings` table intact. With uploads and transcript edits paused,
rebuild completed videos using the new worker configuration:

```sh
kubectl -n videoq exec deployment/videoq-worker -- python -c \
  'from worker_python.tasks.reindexing import reindex_all_videos_embeddings; reindex_all_videos_embeddings()'
```

Keep search unavailable until the rebuild completes. Do not set the old
`PGVECTOR_COLLECTION_NAME=scene_embeddings` with the new profile. Switching back
selects the old table, but any videos uploaded or edited since cutover must be
reindexed there too. Vector spaces are never mixed, truncated or padded.

Gemma 4 uses vLLM's `gemma4` tool and reasoning parsers, with thinking disabled
and no OpenAI reasoning-effort setting. `preserveToolReasoning: true` retains
provider reasoning internally between tool calls. `separateToolSchema: true`
separates tool decisions from final JSON grammar enforcement. The application
overlay enables image/slide inspection using the same Gemma 4 chat service.
EmbeddingGemma's image/audio encoders are not used for indexing.

The inference chart pins the upstream vLLM image, without an engine build.
Its missing audio dependencies use hash-locked upstream wheels on a separate
read-only runtime volume; verified copies on the model PVC support offline restarts.
Every release must pass the upstream vulnerability, file inventory and audio
dependency checks. Earlier profile evidence does not validate this Gemma 4 stack. The new profile
has configuration/contract checks; real GPU execution, memory capacity and
Japanese multimodal quality must pass site acceptance before production use. See the [inspection evidence](../verification/upstream-vllm-inspection.json)
and [profile installation](https://github.com/videoq-jp/videoq/blob/main/charts/videoq-inference/README.md#recommended-gemma-4--embeddinggemma-2--whisper-profile).

Whisper uses **whisper.cpp on CPU** and **vLLM on NVIDIA GPUs**. Both are
accessed through a private gateway that performs VAD and audio normalization,
then restores source-relative segment timestamps. Mac development can also run
whisper.cpp natively with Metal. The app uses `WHISPER_BACKEND=local` and
`WHISPER_LOCAL_URL`, without engine-specific backend aliases.

The older `vllm-nvidia.yaml` recipe dynamically batches speech spans: the gateway submits up to
four concurrently per audio request, accepts two audio requests, and vLLM allows
eight active sequences. CPU speech uses multilingual large-v3-turbo Q5_0 weights,
defaults to one request and uses 30-second worker
checkpoints; NVIDIA uses 300-second checkpoints. These are deployment settings,
not guarantees of recognition accuracy or real-time performance.

The CPU engine reserves two cores. One gateway request shares a 600-second budget
across its speech spans; the local worker waits up to 660 seconds. NVIDIA overlays
use a 110-second gateway budget. `whisper.requestTimeoutSeconds` accepts 1–600
seconds; the budget is not restarted for each span.

The application uses the OpenAI-compatible protocol with private endpoints;
`EMBEDDING_BASE_URL` separates query/indexing embeddings from `OPENAI_BASE_URL`
for chat. Optional `EMBEDDING_API_KEY` selects a separate credential.

Use the [inference chart's installation guide](https://github.com/videoq-jp/videoq/blob/main/charts/videoq-inference/README.md).
It covers installing the signed Whisper image and inference chart, CPU/GPU Helm settings, persistent
weights, disabling runtime downloads, egress restrictions and real-model checks.
Select the matching overlay from `charts/videoq/examples/`; retain it on upgrades.

The CPU baseline disables visual inspection because its chat model accepts text
only. Local visual inspection requires a validated vision model with tool calls
and strict JSON Schema support. The complete vLLM profile requests three dedicated GPUs: chat, embeddings and
Whisper. The `whisper-nvidia.yaml` overlay can add only a speech GPU to a CPU
chat/embedding deployment.
vLLM GPU execution remains subject to actual hardware acceptance. Hardware sizing and Japanese
recognition/answer quality require acceptance on the actual site.

The [signed public release](on-premises-releases.md) includes the CPU Whisper
image, amd64 NVIDIA vLLM image and inference chart. The verifier produces
`verified-inference.json` for the inference chart and `verified-images.json` for
the application. No hosted AI key is needed (neither OpenRouter nor OpenAI):
`OPENAI_API_KEY=local-inference` is an SDK placeholder. Retain the other runtime
Secret values from the [application installation](on-premises.md).

Before accepting the site, test a real upload through transcription, indexing,
cited streaming Q&A and timestamp playback with public egress blocked. A CNI
that enforces NetworkPolicy is required for the provided network restrictions.
Changing embedding weights, quantization, pooling or preprocessing requires
rebuilding existing scene embeddings, even when both models output 1536 dimensions.
The llama.cpp CPU recipe uses native 1536-dimensional gte-Qwen2 embeddings;
the legacy Qwen vLLM recipe uses Matryoshka output set to 1536 dimensions.
The recommended Gemma profile uses EmbeddingGemma 2 at 768 dimensions.
The on-prem edition disables external mail, Google login, Stripe and
YouTube/SearchAPI; administrators issue local accounts and private setup links.

## Mac development with whisper.cpp

Run whisper.cpp directly on macOS so it can use Apple Silicon's Metal backend.
Kubernetes uses whisper.cpp on CPU or vLLM on NVIDIA behind the shared gateway.
whisper.cpp also supports other platforms; this is VideoQ's intended placement.

Install CMake, a C++ toolchain and FFmpeg on the Mac, then run from the VideoQ root:

```sh
git submodule update --init --recursive
cd whisper.cpp
cmake -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build -j --config Release
bash ./models/download-ggml-model.sh large-v3-turbo
./build/bin/whisper-server -m models/ggml-large-v3-turbo.bin \
  --host 127.0.0.1 --port 8080 --inference-path /audio/transcriptions \
  --convert -l auto
```

The bundled submodule pins the server version. Downloads occur during setup;
the server then reads the local model. `--convert` uses the Mac's FFmpeg to
decode the MP3 files sent by the worker. Leave timestamps enabled; the worker
requests `verbose_json` and segment timestamps. Use `-l ja` for Japanese-only
recognition. The request's `whisper-local` model name is the common client alias;
whisper.cpp uses the weights selected by `-m`.

Configure the worker with the API **base URL**, not the full transcription path:

| Speech service | `WHISPER_BACKEND` | `WHISPER_LOCAL_URL` |
|---|---|---|
| Native whisper.cpp, worker on the same Mac | `local` | `http://127.0.0.1:8080` |
| Native whisper.cpp, worker in Docker Desktop | `local` | `http://host.docker.internal:8080` |
| Kubernetes whisper.cpp / vLLM gateway | `local` | `http://videoq-inference-whisper:8080/v1` |

The SDK appends `/audio/transcriptions` to each base URL. The documented
whisper.cpp command exposes that path without `/v1`; the Kubernetes gateway exposes
`/v1/audio/transcriptions`. Recreate the Compose worker after editing `.env`:

```sh
docker compose up -d --force-recreate worker
```

Keep whisper.cpp's unauthenticated development server bound to loopback. For a
real-audio check, use a nonsensitive local video with at least 15 seconds of
speech and the worker's development environment. From the VideoQ root:

```sh
cd apps/worker
LOCAL_AI_TEST_WHISPER_BASE_URL=http://127.0.0.1:8080 \
LOCAL_AI_TEST_WHISPER_VIDEO=/absolute/path/to/speech.mp4 \
  .venv/bin/python -m pytest tests/test_local_whisper_integration.py -v
```

The opt-in test extracts MP3 through the production worker, calls the configured
service, verifies real API segment timestamps and their source-relative offset,
and checks subtitle generation. It does not upload to storage or write to the
database. The same test accepts the Kubernetes gateway base URL, including `/v1`.
Ordinary CI skips this test and does not download speech models.
See the [upstream server options](https://github.com/ggml-org/whisper.cpp/blob/v1.9.5/examples/server/README.md).


## Basic checks on GitHub Actions

`Local Inference Basic Checks` checks chart variants, application and worker API
contracts, and upstream server CLI startup on standard Linux x64, Linux ARM64
and macOS ARM64 runners. It runs for related CI changes, manual dispatch and
a weekly schedule. It does not download models or certify inference quality,
GPU/Metal execution or application lifecycle acceptance.

Linux uses the chart's pinned llama.cpp image and the explicit upstream
whisper.cpp candidates in `.github/inference-basic-packages.json`; these
candidate checks do not change the deployed speech engine. macOS uses Homebrew
bottles and records versions after updating the formula index. Evidence is
retained for seven days as `local-inference-basic-<runner>` artifacts. Existing
image vulnerability and release gates are preserved.


## Upstream CPU speech engine

CPU whisper.cpp now runs directly from an immutable upstream image in a separate
container; VideoQ no longer compiles the engine into its audio gateway. The
gateway keeps preprocessing and the public speech API, connecting to the engine
over Pod loopback. The existing NVIDIA engine and vulnerability gates are retained.
Use `examples/cpu-arm64.yaml` in the inference chart for ARM64. Cached weights
support offline restarts. CI scans each upstream CPU engine on amd64 and arm64.
The explicit whisper.cpp header-only assessment requires matching the complete
flattened filesystem inventory first, and assessed findings remain in reports.
It does not certify the host kernel. See `apps/inference/whispercpp/security/`.

AMD/ROCm configuration is a separate follow-up; no target GPU/OS has been selected
and hardware execution remains unverified. GPU adoption requires physical
acceptance and vulnerability evaluation.

## One RTX 4090 workstation

The [RTX 4090 guide](rtx4090.md) now uses Gemma 4 26B A4B, EmbeddingGemma 2 and
Whisper with **40 GiB CPU weight offload and 128 GiB host RAM**. Select
`rtx4090-gemma4-embeddinggemma.yaml`; it is separate from the three-exclusive-GPU
profile above. This candidate has rendered configuration checks, but its GPU
startup, co-residency, multimodal quality and latency still require site acceptance.
Earlier GPT-OSS acceptance records remain historical evidence only.
