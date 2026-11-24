# Workers AI transcription

The cloud transcription target is `@cf/openai/whisper-large-v3-turbo` on Workers AI.
The `openai` model namespace identifies the model author; inference uses the
Cloudflare AI binding and does not require a provider API key.

## Request path

Media Lambda retains FFmpeg extraction and existing resumable five-minute jobs.
With `WHISPER_BACKEND=workers-ai`, it sends bounded base64 MP3 audio to the HMAC
signed `POST /internal/worker/audio/transcribe` endpoint. TypeScript calls the OpenAI SDK with `response_format=verbose_json` and
`timestamp_granularities=["segment"]`. An in-process custom fetch adapter converts
the SDK multipart request to the existing `env.AI.run()` binding. It makes no
HTTP request and does not forward any SDK Authorization header. The SDK
constructor uses a fixed non-secret `binding` placeholder, as the existing chat
and embedding adapters do; no OpenAI or Cloudflare API key is needed.
TypeScript validates real segment timestamps and returns only normalized segments.
Python retains only extraction and bounded signed audio transport; it does not
construct an OpenAI client for the Workers AI path. On-premises local inference
keeps its existing Python SDK connection. The media worker adds the source interval offset once. Database
checkpoints, retries and quota reservation keep their existing behavior.

Each request accepts at most 3,000,000 audio bytes and 300.5 seconds (five minutes
plus encoder padding). The signed body is capped at 4,100,000 bytes; the response
is bounded separately. Legacy full-file processing splits longer audio into
five-minute chunks and deletes each temporary chunk after use or failure.
No arbitrary remote audio URL is accepted. Provider errors are sanitized and
there is no automatic fallback to another provider.

`vad_filter=true` removes silent input before inference; the returned timestamps
remain relative to the original audio. `condition_on_previous_text=false` avoids
conditioning on earlier decoded text. A saved upload language is passed through;
unset language uses detection. Real silence may return no segments. Text without
real timestamps is rejected because fabricated times would corrupt video search.

## Rollout

1. Deploy the API route and updated media Lambda through normal CI and Terraform
   release ownership. The production backend is `workers-ai`.
2. Verify the signed route with synthetic Japanese speech and silence, then
   confirm the deployed Lambda image contains the adapter.
3. Change only the production `WHISPER_BACKEND` environment setting to
   `workers-ai` through Terraform, after reviewing the exact plan. On-premises
   deployments retain their explicitly configured local provider.
4. Verify source-relative timestamps, health, queue recovery and the active
   configuration. A rollback is an explicit Terraform backend change, using the
   previously verified provider configuration; it is never an inference fallback.

The synthetic model probe is recorded in
[validation](../validation/workers-ai-transcription-2026-11-24.json). It is an
integration check, not evidence that one model is more accurate on all videos.

Official references:
- [Model inputs and timestamped output](https://developers.cloudflare.com/workers-ai/models/whisper-large-v3-turbo/)
- [Workers AI binding](https://developers.cloudflare.com/workers-ai/configuration/bindings/)
