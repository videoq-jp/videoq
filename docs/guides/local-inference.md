---
sidebar_label: Local AI inference
description: Run VideoQ chat, embeddings and Whisper inside the on-premises network.
---

# Keep AI processing on-premises

VideoQ can run chat, embeddings and Whisper on site alongside its web, API and
worker workloads. Initial container/model downloads can use the internet;
uploaded video, audio and AI requests use private services during processing.
The application's default Helm values still select hosted OpenRouter. Applying
the local overlay explicitly switches all three AI functions.

| Recipe | LLM / embedding runtime | Application overlay |
|---|---|---|
| Recommended, NVIDIA + CPU | gpt-oss-20b on vLLM; EmbeddingGemma 2 text encoder on CPU | `local-ai-gpt-oss.yaml` |
| CPU | llama.cpp, separate chat / embedding APIs | `local-ai-llamacpp.yaml` |
| NVIDIA GPU | vLLM CUDA, separate chat / embedding APIs | `local-ai-vllm.yaml` |
| AMD GPU | vLLM ROCm, separate chat / embedding APIs; hardware acceptance pending | `local-ai-vllm.yaml` |

The recommended model combination is **gpt-oss-20b + EmbeddingGemma 2 + Whisper
large-v3-turbo**. Pair `charts/videoq-inference/examples/gpt-oss-embeddinggemma.yaml`
with `charts/videoq/examples/local-ai-gpt-oss.yaml`. This selects one NVIDIA GPU
for chat and CPU services for embeddings and whisper.cpp transcription. The older
Qwen recipes remain explicit compatibility profiles. A small CPU-only VPS cannot
host the recommended chat service; point it at a separate private GPU server.

EmbeddingGemma 2 loads only its 270M text encoder. Queries use the model's
`SearchQuery` prompt and indexed subtitle scenes use `Document`; both return
normalized 768-dimensional vectors. `ai.embeddingProfile: embeddinggemma2`
selects this contract in **both API and worker**. Its private API accepts
`input_type: query|document` in addition to the usual OpenAI embedding fields.
The server rejects other dimensions, unknown aliases and overlong texts.

Apply database migrations before starting the new app. The additive migration
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

gpt-oss uses `reasoningEffort: low` and the OpenAI tool/reasoning parsers.
`preserveToolReasoning: true` retains provider reasoning internally between tool
calls; reasoning is not added to the user-visible answer text.
`separateToolSchema: true` separates tool decisions from final JSON grammar
enforcement so retrieval is not suppressed by the schema constraint.
It is text-only,
so visual inspection stays disabled. EmbeddingGemma's image/audio encoders are
also disabled; multimodal indexing requires separate application work.

Build the CPU inference image from a source/release containing
`embedding_server.py` and its locked sentence-transformers dependencies. Older
Whisper-only images cannot serve this embedding profile. See the
[recommended profile installation](https://github.com/videoq-jp/videoq/blob/main/charts/videoq-inference/README.md#recommended-gpt-oss--embeddinggemma-2--whisper-profile).

Whisper uses **whisper.cpp on CPU** and **vLLM on NVIDIA or AMD GPUs**. Both are
accessed through a private gateway that performs VAD and audio normalization,
then restores source-relative segment timestamps. Mac development can also run
whisper.cpp natively with Metal. The app uses `WHISPER_BACKEND=local` and
`WHISPER_LOCAL_URL`, without engine-specific backend aliases.

The GPU recipes dynamically batches speech spans: the gateway submits up to
four concurrently per audio request, accepts two audio requests, and vLLM allows
eight active sequences. CPU speech uses multilingual large-v3-turbo Q5_0 weights,
defaults to one request and uses 30-second worker
checkpoints; GPU profiles use 300-second checkpoints. These are deployment settings,
not guarantees of recognition accuracy or real-time performance.

The CPU engine reserves two cores. One gateway request shares a 600-second budget
across its speech spans; the local worker waits up to 660 seconds. GPU overlays
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
and strict JSON Schema support. The complete CUDA/ROCm vLLM profiles request three dedicated GPUs: chat, embeddings and
Whisper. The `whisper-nvidia.yaml` overlay can add only a speech GPU to a CPU
chat/embedding deployment.
The AMD inference overlay is `charts/videoq-inference/examples/vllm-amd.yaml`;
`whisper-amd.yaml` can add only an AMD speech GPU to a CPU chat/embedding deployment.
Both use the official upstream ROCm image and `amd.com/gpu`. The site supplies
compatible Linux AMD drivers and the AMD device plugin. See the
[AMD deployment and acceptance steps](https://github.com/videoq-jp/videoq/blob/main/charts/videoq-inference/README.md#amd-rocm-deployment).
vLLM GPU execution remains subject to actual hardware acceptance. Hardware sizing and Japanese
recognition/answer quality require acceptance on the actual site.

The [signed public release](on-premises-releases.md) includes the CPU Whisper
gateway image and inference chart; the chart pins upstream CUDA/ROCm vLLM images. The verifier produces
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
vLLM uses Qwen3-Embedding-4B with Matryoshka output set to 1536 dimensions.
The on-prem edition disables external mail, Google login, Stripe and
YouTube/SearchAPI; administrators issue local accounts and private setup links.

## Independent or existing inference services

Deploy only the inference roles you need. The inference chart accepts
`servers.chat.enabled`, `servers.embedding.enabled` and `whisper.enabled`; the
remaining roles can use existing private services or hosted APIs. Each enabled
chat/embedding role can override `backend` (`llamacpp`/`vllm`) and `accelerator`
(`nvidia`/`amd`); Whisper has its own backend/accelerator settings. The defaults
continue to install all three roles. See the
[environment/role matrix](https://github.com/videoq-jp/videoq/blob/main/charts/videoq-inference/README.md#select-roles-and-environments).

Configure the API and worker consistently. Chat and embeddings use their own
URLs and model aliases. For an existing speech API, use `WHISPER_BACKEND=local`
(the compatible wire protocol), and set `WHISPER_LOCAL_URL`,
`WHISPER_LOCAL_MODEL` and optional `WHISPER_LOCAL_API_KEY`. In the application
chart these map to `ai.whisperLocalUrl`, `ai.whisperLocalModel` and a Secret key
`WHISPER_LOCAL_API_KEY`. The built-in gateway still requires its `whisper-local`
alias. A separate speech key takes precedence over `OPENAI_API_KEY`; when absent,
the existing shared-key behavior is preserved. Hosted `WHISPER_BACKEND=openai`
continues to use OpenAI's endpoint and `whisper-1` independently of local settings.

Compatible services must support the operations VideoQ actually uses: chat tool
calls and the selected JSON Schema mode, matching 1536-dimensional query/index
embeddings, and `verbose_json` speech with real segment timestamps. A matching
HTTP API name alone does not prove that a model is compatible. No private-service
failure automatically retries against a hosted provider. Lambda workers can load
these independent URLs/model aliases/credentials from their app SSM SecureString;
explicit environment variables take precedence.

The Linux arm64 CPU example is `charts/videoq-inference/examples/cpu-arm64.yaml`.
For speech-only deployment use `speech-only-cpu.yaml`, or disable chat/embedding
while selecting the matching GPU speech profile. For mixed hardware use the
standalone `mixed-engines.yaml` example. Keep API and worker model identities
consistent and reindex before changing embedding weights.

## Mac development with llama.cpp

Use the maintained [Homebrew llama.cpp package](https://formulae.brew.sh/formula/llama.cpp),
which includes `llama-server`. Run it natively on Apple Silicon for Metal GPU
access. The Linux Kubernetes recipe explicitly uses CPU (`--gpu-layers 0`);
it is separate from this native Mac setup.

Download the same reviewed GGUF files as the inference chart, with pinned
revisions and checksums:

```sh
brew install llama.cpp
mkdir -p .local-models/llama
curl --fail --location --output .local-models/llama/Qwen3-4B-Q4_K_M.gguf \
  https://huggingface.co/Qwen/Qwen3-4B-GGUF/resolve/bc640142c66e1fdd12af0bd68f40445458f3869b/Qwen3-4B-Q4_K_M.gguf
echo "7485fe6f11af29433bc51cab58009521f205840f5b4ae3a32fa7f92e8534fdf5  .local-models/llama/Qwen3-4B-Q4_K_M.gguf" | shasum -a 256 -c -
curl --fail --location --output .local-models/llama/gte-Qwen2-1.5B-instruct-Q4_K_M.gguf \
  https://huggingface.co/second-state/gte-Qwen2-1.5B-instruct-GGUF/resolve/124fbdad7d80e987f3a4d8cd201f721ca37fe9b8/gte-Qwen2-1.5B-instruct-Q4_K_M.gguf
echo "a40df5cabb8c70f2fa144bc6a8674c2c987bfe3b4571134c767832aae1d246b9  .local-models/llama/gte-Qwen2-1.5B-instruct-Q4_K_M.gguf" | shasum -a 256 -c -
```

Run the following in two separate terminals. `--gpu-layers 99` requests GPU
offload; check the startup log for the Metal device and actual offloaded layers.
Both model processes share the Mac's available unified memory.

```sh
# Terminal 1: chat
llama-server --model .local-models/llama/Qwen3-4B-Q4_K_M.gguf \
  --alias videoq-chat --host 127.0.0.1 --port 8000 \
  --ctx-size 8192 --parallel 1 --gpu-layers 99 --offline \
  --jinja --reasoning off

# Terminal 2: embeddings (native 1536 dimensions)
llama-server --model .local-models/llama/gte-Qwen2-1.5B-instruct-Q4_K_M.gguf \
  --alias gte-qwen2-1.5b-q4km-124fbdad --host 127.0.0.1 --port 8001 \
  --ctx-size 8192 --parallel 1 --gpu-layers 99 --offline \
  --embedding --pooling last
```

For API/worker processes running in Docker Desktop, apply these values to both
processes' environment (for Compose, `.env`; if the API uses a separate local
vars file, keep it consistent there too):

```dotenv
OPENAI_BASE_URL=http://host.docker.internal:8000/v1
OPENAI_API_KEY=local-inference
LLM_MODEL=videoq-chat
LLM_REASONING_EFFORT=none
LLM_SEPARATE_TOOL_SCHEMA=true
LLM_REQUEST_TIMEOUT_MS=600000
LLM_STREAM_TIMEOUT_MS=600000
EMBEDDING_BASE_URL=http://host.docker.internal:8001/v1
EMBEDDING_API_KEY=local-inference
EMBEDDING_MODEL=gte-qwen2-1.5b-q4km-124fbdad
VIDEO_VISUAL_ENABLED=false
```

For processes running directly on the Mac, replace `host.docker.internal` with
`127.0.0.1`. Keep both servers on loopback. The embedding model/alias and endpoint
must match between API and worker. Reindex existing scenes before switching
embedding models. Whisper configuration is separate; see the next section.

This is a native Mac setup recipe, not a recorded Mac/Metal acceptance result.
The published Homebrew version can differ from the Linux image's pinned build;
verify tool calls, JSON Schema, 1536-dimensional embeddings and an end-to-end
VideoQ upload/answer on the installed version before adopting it.

## Mac development with whisper.cpp

Run whisper.cpp directly on macOS so it can use Apple Silicon's Metal backend.
Kubernetes uses whisper.cpp on CPU or vLLM on NVIDIA or AMD behind the shared gateway.
whisper.cpp also supports other platforms; this is VideoQ's intended placement.

Install the [Homebrew whisper.cpp package](https://formulae.brew.sh/formula/whisper.cpp)
and FFmpeg, then run from the VideoQ root. Supported bottle platforms use
prebuilt binaries, including `whisper-server`:

```sh
brew update
brew install whisper.cpp ffmpeg
mkdir -p .local-models/whisper
curl --fail --location --output .local-models/whisper/ggml-large-v3-turbo-q5_0.bin \
  https://huggingface.co/ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1/ggml-large-v3-turbo-q5_0.bin
echo "394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2  .local-models/whisper/ggml-large-v3-turbo-q5_0.bin" | shasum -a 256 -c -
whisper-server -m .local-models/whisper/ggml-large-v3-turbo-q5_0.bin \
  --host 127.0.0.1 --port 8080 --inference-path /audio/transcriptions \
  --convert -l auto
```

The reviewed Homebrew package is whisper.cpp 1.9.5. Model revision and checksum
are pinned above; downloads occur during setup and the server then reads the
local model. The optional Git submodule remains available for source-level
experiments or platforms without a suitable package. `--convert` uses the Mac's FFmpeg to
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

`Local Inference Basic Checks` runs on standard Linux x64, Linux ARM64 and
macOS ARM64 runners for related CI changes, manual dispatch and a weekly schedule.
It checks Helm configuration variants, chat/speech/embedding API contracts, and
startup of upstream server packages. Linux uses pinned upstream images; macOS
uses Homebrew bottles and records package versions. No model weights are fetched
by these basic checks. Model accuracy, GPU/Metal execution and the complete
application lifecycle have separate acceptance checks. The workflow is
`.github/workflows/local-inference-basic.yml`; evidence artifacts are named
`local-inference-basic-<runner>` and retained for seven days.

On 2026-10-27, [native basic checks passed on all three platforms](https://github.com/yukiharada1228/videoq/actions/runs/40441493651).
A separate [CPU amd64 source-build acceptance job passed](https://github.com/yukiharada1228/videoq/actions/runs/40440856356/job/121980594329):
upload, real Japanese ASR, indexing, cited and streamed answers, Chromium media seeking,
object/database restore, upgrade and rollback. The 45-character Japanese fixture had
zero character edits; this is a single sample, not a general accuracy benchmark.
Public IP egress and external DNS were blocked during application acceptance.
That earlier workflow is marked failed because its macOS basic job used a stale
Homebrew index; the corrected three-platform basic run above passed. These results
do not establish GPU/Metal or ARM model inference, or signed-release acceptance.
