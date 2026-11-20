> Historical pilot evidence. The adopted target and production authentication procedure are in [the Workers AI runbook](openai-transcription.md). Pilot API-token examples below are not the production runtime configuration.

# Cloudflare AI pilot

Status: opt-in integration implemented; production settings unchanged. On 2026-11-21,
the VideoQ account's `videoq-pilot` Gateway and scoped API tokens were created.
Workers AI Japanese/English speech inference and an authenticated Gateway Workers AI
request succeeded live. A request without Gateway authentication returned 401.
Logs and cache are disabled. Credentials are in the ignored root `.env` (0600).
The initial speech token was rotated and its old value was verified invalid.
See [live evidence](evidence/cloudflare-ai-pilot-2026-11-21.json).

OpenRouter comparison and direct/Gateway model preflights subsequently passed using
a temporary one-hour inference key. The key was deleted after testing; an inference
request with it returned 401, and its local copy was removed. No production WIF
trust rules or endpoints were changed. The temporary key needed a $1 limit because
OpenRouter audio rejected the original $0.25 limit with a $0.50 minimum-availability
requirement. Reported total key usage at the final read was $0.000423485.

| Public fixture, single run | OpenRouter CER / wall time | Workers AI CER / wall time |
| --- | --- | --- |
| Japanese, 10.44s | 0% / 2.57s | 0% / 1.52s |
| English, 5.832s | 22.7% / 1.06s | 2.7% / 6.17s |

These are observations, not latency percentiles or broad quality rankings. Each
provider uses its own decoding and routing settings. The preflights verified
structured answers, streamed completion, tool call followed by a final answer,
image input, and 1536-dimensional query/index embeddings with the actual adapters.
With `--gateway`, only chat/image calls use Gateway; embeddings and worker speech
remain direct.

A 310.76-second synthetic fixture placed public Japanese speech before a 294.56s
silent gap and public English speech after it. Default Whisper decoding inserted
nine Japanese thank-you captions in the silent gap. The adapter now sets
`vad_filter=true` and `condition_on_previous_text=false`. That removed false captions,
but the very quiet English recording (original peak about -45 dB) was missed in
this long-gap construction. Giving only the synthetic English fixture 30 dB gain
restored its caption at 304.88–310.04s, across the 300s chunk boundary, without false
silent-gap captions. This is a recorded sensitivity limitation; the production
pipeline does not automatically amplify audio. Real low-volume lecture validation
is still required. Do not switch production transcription based on these tests.

## AI Gateway: chat and image inspection

Set `LLM_BASE_URL=https://gateway.ai.cloudflare.com/v1/ACCOUNT_ID/GATEWAY_ID/openrouter`
and provide secret `AI_GATEWAY_TOKEN` with AI Gateway Run permission. Keep the
existing `OPENROUTER_FEDERATION_POLICY_ID` and AWS federation configuration (or
`OPENROUTER_API_KEY`). Federation still exchanges tokens directly with OpenRouter;
the resulting inference token is forwarded through Gateway. A failed exchange
never falls back to a stale fixed key. The Gateway token and provider token have
separate headers. The Node runtime accepts the same settings.

Use a staging/pilot deployment first. The setup session created `videoq-pilot`; the application code itself does not provision resources.
Gateway Run tokens are account scoped, not scoped to one Gateway.
The provider-native endpoint preserves the existing OpenAI SDK and LangChain adapters.

The pilot sends `cf-aig-skip-cache: true` and `cf-aig-collect-log: false`, so request
and response bodies are not stored in Gateway logs. This limits request-level
troubleshooting until an operator explicitly chooses a retention policy and enables
logging in the implementation. These headers do not control Logpush exports; check
Gateway configuration before using private course material. Do not enable Logpush
for the pilot. Embedding and transcription endpoints are unchanged; avoid setting
`OPENAI_BASE_URL` to Gateway for this chat-only pilot.

Verify a cited answer, a follow-up, image inspection, streaming cancellation and an
upstream failure. Compare direct and Gateway first-token/total latency and error
rates on identical inputs. Keep the application cost ledger authoritative; verify
provider cost reporting rather than assuming every model is priced automatically.
Disable the pilot by restoring the previous `LLM_BASE_URL` (or unsetting it when
using the shared default). No embedding rebuild is involved.

## Workers AI: timestamped Whisper

The Python worker supports `WHISPER_BACKEND=workers-ai`. Set
`CLOUDFLARE_ACCOUNT_ID` and secret `WORKERS_AI_API_TOKEN` using the Workers AI dashboard token template (Workers AI Read and Edit
permissions). The adapter calls `@cf/openai/whisper-large-v3-turbo` directly from the
existing audio worker; audio extraction and storage remain in the existing pipeline.
Do not change Lambda production configuration until the comparison passes. For a
pilot inject the token into the worker process securely; this change does not add
Terraform or Secrets Manager provisioning for these optional settings.

Full-file audio is split into at most 300-second chunks even when compressed files
are small. Existing resumable transcription intervals are already bounded to 300
seconds. Chunk timestamps are shifted once back to source time. Missing/malformed
timestamps fail the task; another provider is never called as a fallback.

From the repository root, with FFmpeg installed and credentials in the ignored root
`.env` file (or exported in the process environment):

```sh
PYTHONPATH=apps/worker uv run --env-file .env --project apps/worker --extra dev python \
  apps/worker/scripts/compare_cloud_whisper.py \
  --output /tmp/videoq-cloud-whisper-comparison.json
```

Use `--backends workers-ai` for a single-provider smoke test. The script verifies
checksums of the existing CC BY 4.0 FLEURS Japanese and English fixtures, measures
elapsed time, normalized character error rate, timestamp validity and segment count,
and writes results without database access. Missing credentials are reported by
variable name. Provider error bodies and secrets are excluded. Nonzero exit means
missing configuration, a request failure or invalid timestamps; a zero exit is a
smoke test result, not an automatic production quality approval.

Before adoption, add representative Japanese lecture samples with reference text,
including specialist terms, silence, English mixed with Japanese and long recordings.
Compare CER against OpenRouter, listen to timestamp boundaries, inspect silence
hallucinations, and measure p50/p95 latency across repeated runs. These short public
fixtures alone cannot establish lecture quality. Roll back by restoring
`WHISPER_BACKEND=openrouter`; existing stored transcripts and embeddings are retained.

The report's Workers AI estimate uses $0.000513/audio minute, checked 2026-11-21;
it excludes extraction, storage, retries and all other infrastructure. OpenRouter
cost must be taken from actual provider usage. Do not infer savings from a single
model price.

Official references:

- [OpenRouter provider endpoint](https://developers.cloudflare.com/ai-gateway/usage/providers/openrouter/)
- [Gateway authentication](https://developers.cloudflare.com/ai-gateway/configuration/authentication/)
- [Gateway logging](https://developers.cloudflare.com/ai-gateway/observability/logging/)
- [Gateway pricing](https://developers.cloudflare.com/ai-gateway/reference/pricing/)
- [Whisper model](https://developers.cloudflare.com/workers-ai/models/whisper-large-v3-turbo/)

## Repeat the OpenRouter/Gateway preflight

With a short-lived development inference key and Gateway credentials configured,
run from the repository root (the script never changes production):

```sh
VIDEOQ_TEST_PYTHON="$PWD/apps/worker/.venv/bin/python" npm run openrouter:check \
  --workspace @videoq/api -- ../../apps/inference/whisper/tests/fixtures/fleurs-ja-00.mp3 --probe
LLM_BASE_URL=https://gateway.ai.cloudflare.com/v1/ACCOUNT_ID/videoq-pilot/openrouter \
  VIDEOQ_TEST_PYTHON="$PWD/apps/worker/.venv/bin/python" npm run openrouter:check \
  --workspace @videoq/api -- ../../apps/inference/whisper/tests/fixtures/fleurs-ja-00.mp3 --probe --gateway
```

The temporary key used in this session has been revoked, so these commands need a
new development key or credentials matching an existing WIF policy. The local AWS
principal differs from the production API principal; do not relax production trust
policies just to run a local probe.

## Original demo-lesson evaluation

Five existing original Japanese narrated lessons were additionally evaluated with
Workers AI. The repository's `course.json` narration is the reference; the video
manifest defines three chapter windows per lesson. The videos use synthetic macOS
Kyoko narration, so these results do not establish natural lecture performance.
All 15 chapter windows had captions and all returned timestamps passed validation.

| Subject, approximately 60 seconds each | Raw normalized CER | Wall time including extraction |
| --- | --- | --- |
| Japanese | 0.7% | 5.01s |
| Mathematics | 13.1% | 5.37s |
| Science | 22.0% | 5.96s |
| Social studies | 1.7% | 7.81s |
| English lesson narrated in Japanese | 6.2% | 10.18s |

Raw CER counts equivalent numeric, Latin and kanji spellings as differences. Manual
review nevertheless found actual content errors: mathematics `導関数` became
`同関数`, some `エックス` became `ウックス`, and science `転写` became `電車`.
The high mathematics/science CER is partly spelling variation and must not be
interpreted entirely as factual error, but those concrete terminology errors
matter for downstream retrieval and answers. Keep production transcription on the
existing provider. Gateway has passed the integration preflight; its staged rollout
still requires application-level validation and an operational reason to add it.

Repeat without database writes:

```sh
WHISPER_BACKEND=workers-ai PYTHONPATH=apps/worker \
  uv run --env-file .env --project apps/worker --frozen python \
  apps/worker/scripts/benchmark_demo_whisper.py \
  --output /tmp/videoq-demo-whisper-live.json
```

The next transcription adoption gate is representative natural lecture audio,
including specialist terms and low-volume speech, with a checked reference and
citation-boundary review. No production change is justified by this demo benchmark.

## Full natural lecture: video 139

The user selected `https://videoq.jp/videos/139`. The entire 2,868.616-second lecture
was evaluated as ten sequential requests using the same 300-second chunking,
Japanese language, VAD and independent decoding settings as the optional adapter.
[Summary evidence](evidence/cloudflare-ai-video139-2026-11-21.json) records hashes,
settings and measurements. Source media, signed URLs and complete transcripts are
kept only in the ignored `.cutover-secrets/cloudflare-ai-video139/` directory.

- Inference request time totaled 214.45 seconds (about 3m34s), excluding acquisition
  and extraction. Model-price inference estimate: $0.02453, excluding infrastructure.
- All ten chunks returned subtitles: 594 raw segments, monotonic start times,
  zero segments outside their source chunk bounds. The last segment ends at 2,865.44s.
- Normalized character-sequence similarity to the saved transcript was 96.26%.
  This is **not accuracy**: the saved transcript is not a checked human reference,
  and its historical model/provider are unknown. Its 44 cues may reflect scene
  merging, so their count cannot establish a model granularity advantage.
- Slide review at 1m30s confirms `射影変化`; both saved subtitles and Workers AI
  produce `遮影変化`. Review at 15m confirms `非等方性LoGフィルタの近似`.
  Workers AI improves `非統合性` to `非等方性` in that passage, but changes `近似`
  to `禁止` at about 15m14s. There are improvements and regressions, not a uniform
  quality improvement.

Decision: retain the current production transcription path. Workers AI can remain
an opt-in experimental backend, with low inference cost and a working long-audio
path, but this lecture does not justify a production switch. A full human reference
would be needed for an accuracy claim. Valid timestamps alone do not prove exact
acoustic synchronization or no omitted words. The original VideoQ media, transcript,
index, status and production routing were not changed by this evaluation.

Private candidate SRT: `.cutover-secrets/cloudflare-ai-video139/workers-ai.srt`.
Baseline SRT: `.cutover-secrets/cloudflare-ai-video139/baseline.srt`.

The resumable evaluator can repeat this workflow on another authorized local video:

```sh
PYTHONPATH=apps/worker uv run --env-file .env --project apps/worker --frozen python \
  apps/worker/scripts/benchmark_lecture_whisper.py \
  --video /path/to/authorized-lecture.mp4 \
  --output .cutover-secrets/lecture-evaluation/workers-ai.json
```

Completed chunks are checkpointed with a source SHA-256 and inference settings;
an interrupted run resumes pending chunks without paying for completed chunks
again. A mismatched source/settings checkpoint is rejected. Keep output paths
private: checkpoints contain transcript text.
