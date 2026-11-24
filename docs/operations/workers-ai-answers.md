# Workers AI: unified Gemma chat and vision

VideoQ uses `@cf/google/gemma-4-26b-a4b-it` for answer generation, conversation summaries, and image inspection inside video tools. Embeddings and transcription also use Workers AI through their dedicated model bindings.

The API continues to use its existing LangChain Chat Completions agent and OpenAI vision SDK. In Cloudflare Workers these send requests through the native `AI` binding; Node can use Workers AI's OpenAI-compatible endpoint. This retains the existing tool protocol, citations, deadlines, cancellation, structured output validation, and usage ledger in both Workers and Node runtimes.

## Configuration

The API's Wrangler development and production configuration includes `ai: { "binding": "AI" }` and selects Gemma. No separate inference API token is required in Workers. Leave `LLM_BASE_URL` unset to select the native binding. The SDK's placeholder credential never leaves the application; the binding supplies Cloudflare authentication. The CI deployment config preserves the `ai` binding.

The transport forwards request cancellation to `AI.run()` and returns its raw response without buffering. Native streams include per-delta usage and a final aggregate outside the OpenAI choices schema: the model boundary uses only the aggregate for usage and converts that final frame into an empty choices chunk.

For Node or another account, use the following API runtime settings:

```dotenv
LLM_BASE_URL=https://api.cloudflare.com/client/v4/accounts/YOUR_ACCOUNT_ID/ai/v1
LLM_MODEL=@cf/google/gemma-4-26b-a4b-it
LLM_API_KEY=your-workers-ai-api-token
LLM_MAX_TOKENS=4096
LLM_SEPARATE_TOOL_SCHEMA=true
LLM_PRESERVE_TOOL_REASONING=true
```

Local Workers development uses the native binding after Wrangler login. Explicit REST credentials can instead be placed in the ignored `apps/api/.dev.vars`. In Node, all three tasks share `LLM_BASE_URL`, `LLM_MODEL`, and `LLM_API_KEY`. The earlier experimental `ANSWER_*` settings have been removed; migrate them to `LLM_*` instead of keeping two model profiles.

Keep `OPENAI_BASE_URL`, `OPENROUTER_*`, `EMBEDDING_*`, and media-worker transcription settings in place. These still serve embeddings and transcription. Workers AI REST requires a dedicated `LLM_API_KEY`; native Workers inference requires the `AI` binding. Missing authentication fails before inference instead of forwarding another provider's key. This change does not switch the Python media worker to Workers AI.

The Gemma profile sends `chat_template_kwargs.enable_thinking=false` for answers, summaries, and image observations. This prevents hidden reasoning from consuming the output budget for these bounded evidence tasks. `LLM_MAX_TOKENS` accepts integers from 1024 through 32768; Gemma and Workers AI REST default to 4096. Other compatible profiles retain their existing default budgets when it is unset.

Separate tool/schema handling lets the model choose tools without the terminal-answer grammar, then produces the final answer under the strict schema. Without this separation, the initial Gemma live probe failed at the tool stage. Decision requests, image requests, and final answers are all recorded in the usage ledger. Existing timestamp/citation checks and visual-call budgets remain in effect.

## Verification

```sh
# Configuration only; no inference
npm run workers-ai:check --workspace @videoq/api

# Billed synthetic text/tool/summary probes
npm run workers-ai:check --workspace @videoq/api -- --probe

# Billed real-image tool round trips; environment supplies the LLM_* settings
WORKERS_AI_VISUAL_LIVE=1 npm run test:unit --workspace @videoq/api -- test/workers-ai-visual.live.test.ts
```

The preflight loads root `.env`, then `apps/api/.dev.vars`, then process environment overrides. It checks Japanese answers, missing evidence, streaming, tool invocation/result replay, strict structured output, conversation summaries, and usage. It performs no database writes.

The opt-in live visual test uses two synthetic JPEGs (a red circle and a blue square) and substitutes only database/media fixtures. It exercises the real RAG agent, MCP tool execution, nested image SDK, final citations, and usage recording, in both normal and streaming modes. Every answer and image-model call must use the same Gemma model. REST mode loads credentials from process environment and never reads user videos or uploads production media. Native mode (`WORKERS_AI_NATIVE_LIVE=1`, `WORKERS_AI_NATIVE_CONFIG=/path/to/probe-wrangler.jsonc`) uses `getPlatformProxy` with a separate AI-only Wrangler config and the logged-in account. The Node RPC bridge cannot serialize AbortSignal and races cancellation at the SSE terminator, so the live native fixture bridge strips the signal and buffers finite fixture responses before passing them to the SDK. This workaround is test-only: separate workerd transport tests verify production cancellation forwarding and raw streaming responses.

On 2026-11-22 the VideoQ Workers AI account passed the Gemma preflight and both real-image RAG scenarios. Temporary local Wrangler authentication was used for inference only; no credentials were committed or installed in production. These synthetic checks establish API/pipeline compatibility, not comprehensive OCR or answer-quality performance on real lectures. Before production cutover compare representative lectures, diagrams, and questions in staging.

## Deployment and rollback

The Workers deployment needs the `AI` binding and the checked-in Gemma `LLM_*` vars. No new inference secret is needed. The probes do not themselves deploy production. Before upload, the deployment resource handoff and state checks must confirm the existing D1/Vectorize targets and traffic state are preserved. The Node runtime still needs its own Workers AI REST service token.

To roll back, use the saved previous Worker version or restore the previous `LLM_MODEL`, `LLM_BASE_URL`, `LLM_API_KEY`, and optional `LLM_*` switches/budget together, then redeploy/restart. Gemma ignores legacy `LLM_REASONING_EFFORT` settings and uses its model-specific thinking switch.

References:

- [Gemma 4 on Workers AI](https://developers.cloudflare.com/workers-ai/models/gemma-4-26b-a4b-it/)
- [Workers AI OpenAI-compatible endpoints](https://developers.cloudflare.com/workers-ai/configuration/open-ai-compatibility/)

## Production cutover: 2026-11-22

Deployed Worker version `bf85aca3-5de1-4836-9baf-f6eeea89a761` to the existing `videoq-api` in account `12daec56fdba43f677f2766ee26a5a39`. The protected upload used the prebuilt artifact and separately locked, signature-verified deployment tools. The live setting comparison confirmed that only `AI`, `LLM_MODEL`, `LLM_MAX_TOKENS`, `LLM_SEPARATE_TOOL_SCHEMA`, and `LLM_PRESERVE_TOOL_REASONING` changed; all other bindings, including existing secrets, D1, Vectorize, embeddings configuration, and media connections, were preserved. No new inference API token was installed.

After deployment, `/health` returned HTTP 200 with production status `ok`, and `/ready` returned HTTP 200 with database status `ok`. The real-image native binding fixture tests passed in normal and streaming modes before upload. The native usage envelope and cancellation behavior also passed workerd transport tests. Production user-video answers were not generated as part of the health checks.
