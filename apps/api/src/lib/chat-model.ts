import { ChatOpenAICompletions } from "@langchain/openai";
import type OpenAI from "openai";
import type { AnswerCostLedger } from "./answer-cost-ledger";
import {
  DEFAULT_LLM_MODEL,
  LlmConfigurationError,
  LlmProviderError,
  resolveLlmConnection,
  providerModel,
} from "./openai";
import type { Bindings } from "../types/bindings";

/**
 * LLM 呼び出しの土台（ChatOpenAI）。
 * strict json_schema と tool calling に対応する Chat Completions が必要:
 *   - temperature=0 / model は LLM_MODEL（既定 gpt-6-luna）
 *   - LLM_BASE_URL（未設定なら OPENAI_BASE_URL）で OpenAI 互換エンドポイントへ差し替え可能
 *   - 失敗は LlmConfigurationError / LlmProviderError のどちらかに正規化する
 */

/**
 * リトライは行わない（直 fetch 実装と同じ挙動）。
 * 429/5xx の自動リトライはレイテンシとクォータ予約の保持時間を伸ばすだけで、
 * ストリーミング中の切断はどのみち復旧できない。
 */
const MAX_RETRIES = 0;

/** Compatibility boundaries only: tool/schema separation, usage ledger and refusals.
 * Content, tool arguments and finish metadata are assembled by LangChain Core.
 */
class AnswerChatModel extends ChatOpenAICompletions {
  costLedger?: AnswerCostLedger;
  separateToolSchema = false;
  preserveToolReasoning = false;
  // Scoped to this answer's model instance. LangChain's Chat Completions
  // converter drops provider reasoning fields when replaying tool messages.
  private readonly toolReasoning = new Map<string, Record<string, string>>();
  override completionWithRetry(request: OpenAI.Chat.ChatCompletionCreateParamsStreaming, options?: OpenAI.RequestOptions): Promise<AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>>;
  override completionWithRetry(request: OpenAI.Chat.ChatCompletionCreateParamsNonStreaming, options?: OpenAI.RequestOptions): Promise<OpenAI.Chat.Completions.ChatCompletion>;
  override completionWithRetry(request: OpenAI.Chat.ChatCompletionCreateParams, options?: OpenAI.RequestOptions): Promise<OpenAI.Chat.Completions.ChatCompletion | AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>>;
  override async completionWithRetry(request: OpenAI.Chat.ChatCompletionCreateParams, options?: OpenAI.RequestOptions): Promise<OpenAI.Chat.Completions.ChatCompletion | AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>> {
    if (this.preserveToolReasoning) {
      request = { ...request, messages: request.messages.map(message => {
        if (message.role !== "assistant" || !message.tool_calls?.length) return message;
        const id = message.tool_calls[0].id;
        return { ...message, ...this.toolReasoning.get(id) };
      }) };
    }
    if (this.separateToolSchema && request.tools?.length && request.response_format?.type === "json_schema") {
      // Some compatible servers apply the final-answer grammar to tool calls
      // too, preventing retrieval. Decide tools without that grammar, then
      // generate the terminal answer with native schema enforcement. A draft
      // answer is discarded, never streamed or used as conversion input.
      const { response_format: _format, stream_options: _streamOptions, ...decisionRequest } = request;
      const decision = await this.completionWithRetry({ ...decisionRequest, stream: false }, options);
      const completed = decision;
      const choice = completed.choices[0];
      if (!choice || choice.message.refusal || !["stop", "tool_calls"].includes(choice.finish_reason)) {
        throw new LlmProviderError("Local tool decision refused or incomplete.");
      }
      const calls = choice.message.tool_calls;
      if (calls?.length) {
        const normalized = { ...completed, choices: [{ ...choice, message: { ...choice.message, content: null } }] };
        if (!request.stream) return normalized;
        const toolCalls = calls.map((call, index) => {
          if (call.type !== "function") throw new LlmConfigurationError("Local inference requires function tool calls.");
          return { index, id: call.id, type: "function" as const, function: call.function };
        });
        // eslint-disable-next-line @typescript-eslint/require-await -- Preserve the asynchronous interface and rejection semantics.
        return (async function* (): AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk> {
          const base = { id: completed.id, object: "chat.completion.chunk" as const,
            created: completed.created, model: completed.model };
          yield { ...base, choices: [{ index: 0, delta: { role: "assistant", tool_calls: toolCalls }, finish_reason: null }] };
          yield { ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: completed.usage };
        })();
      }
      return this.completionWithRetry({ ...request, tools: undefined, tool_choice: undefined, parallel_tool_calls: undefined }, options);
    }
    // The SDK's .parse() tries to parse nonempty tool preambles as final JSON.
    // Keep native schema enforcement on the request, and let providerStrategy
    // validate terminal responses after the agent has processed tool calls.
    const clientOptions = this._getClientOptions(options);
    const call = this.costLedger?.begin("answer_model", request.model);
    const trackedRequest = request.stream
      ? { ...request, stream_options: { ...(request.stream_options ?? {}), include_usage: true } }
      : request;
    try {
      const response = await this.caller.callWithOptions({ maxRetries: MAX_RETRIES }, () =>
        this.client.chat.completions.create(trackedRequest, { ...clientOptions, maxRetries: MAX_RETRIES }));
      if (request.stream) {
        const chunks = response as AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>;
        const remember = (ids: string[], reasoning: Record<string, string>) => {
          if (this.preserveToolReasoning) for (const id of ids) this.toolReasoning.set(id, { ...reasoning });
        };
        return (async function* () {
          let usage: unknown;
          const ids: string[] = [];
          const reasoning: Record<string, string> = {};
          try {
            for await (const chunk of chunks) {
              // Core's native completions events currently omit refusal deltas.
              // Reject at the boundary; do not reimplement message conversion.
              if (chunk.choices.some(choice => choice.delta?.refusal)) {
                throw new LlmProviderError("Structured answer refused or incomplete.");
              }
              if (chunk.usage) usage = chunk.usage;
              for (const choice of chunk.choices) {
                if (choice.index !== 0) continue;
                const delta = choice.delta as typeof choice.delta & { reasoning?: string; reasoning_content?: string };
                for (const key of ["reasoning", "reasoning_content"] as const) {
                  if (typeof delta[key] === "string") reasoning[key] = (reasoning[key] || "") + delta[key];
                }
                for (const tool of delta.tool_calls ?? []) if (tool.id) ids.push(tool.id);
              }
              yield chunk;
            }
            remember(ids, reasoning);
            call?.complete(usage);
          } catch (error) {
            if (error instanceof Error && error.name === "AbortError") call?.interrupt(usage);
            else call?.fail(usage);
            throw error;
          }
        })();
      }
      const completion = response as OpenAI.Chat.Completions.ChatCompletion;
      if (this.preserveToolReasoning) for (const choice of completion.choices) {
        const message = choice.message as typeof choice.message & { reasoning?: string; reasoning_content?: string };
        const reasoning: Record<string, string> = {};
        for (const key of ["reasoning", "reasoning_content"] as const) {
          if (typeof message[key] === "string") reasoning[key] = message[key];
        }
        for (const tool of message.tool_calls ?? []) this.toolReasoning.set(tool.id, reasoning);
      }
      call?.complete(completion.usage);
      if (completion.choices.some(choice => choice.message.refusal)) {
        throw new LlmProviderError("Structured answer refused or incomplete.");
      }
      return response;
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") call?.interrupt();
      else call?.fail();
      throw error;
    }
  }
}

export function createChatModel(
  env: Bindings,
  opts: { maxTokens: number; timeoutMs: number; costLedger?: AnswerCostLedger },
): ChatOpenAICompletions {
  const { apiKey, baseURL } = resolveLlmConnection(env);
  const model = providerModel(env.LLM_MODEL || DEFAULT_LLM_MODEL, baseURL);
  // useResponsesApi: false でも ChatOpenAI はモデル名で /responses を選ぶ。
  // 互換サーバーでも /chat/completions を使うため、専用クラスで固定する。
  const reasoningEffort = env.LLM_REASONING_EFFORT || (["gpt-6-luna", "openai/gpt-6-luna"].includes(model) ? "none" : undefined);
  const chatModel = new AnswerChatModel({
    model,
    apiKey,
    configuration: { baseURL },
    temperature: 0,
    reasoning: reasoningEffort ? { effort: reasoningEffort } : undefined,
    // Send the field explicitly for OpenRouter slugs and custom compatible aliases.
    modelKwargs: reasoningEffort ? { reasoning_effort: reasoningEffort } : undefined,
    maxTokens: opts.maxTokens,
    timeout: opts.timeoutMs,
    maxRetries: MAX_RETRIES,
  });
  chatModel.costLedger = opts.costLedger;
  chatModel.separateToolSchema = env.LLM_SEPARATE_TOOL_SCHEMA === "true";
  chatModel.preserveToolReasoning = env.LLM_PRESERVE_TOOL_REASONING === "true";
  return chatModel;
}

/** OpenAI SDK / LangChain が投げた例外から HTTP ステータスを拾う。 */
function statusOf(error: unknown): number | null {
  if (typeof error !== "object" || error === null) return null;
  const e = error as { status?: unknown; response?: { status?: unknown } };
  if (typeof e.status === "number") return e.status;
  if (typeof e.response?.status === "number") return e.response.status;
  return null;
}

/**
 * LLM 例外を VideoQ のエラー分類へ正規化する。
 *   - 401（キー不正）→ LlmConfigurationError（HTTP 400 / SSE LLM_CONFIGURATION_ERROR）
 *   - それ以外       → LlmProviderError（HTTP 500 でマスク / SSE LLM_PROVIDER_ERROR）
 * AbortError は呼び出し側（クライアント切断）に委ねるのでそのまま投げ直す。
 */
export function toLlmError(error: unknown): unknown {
  if (error instanceof LlmConfigurationError || error instanceof LlmProviderError) {
    return error;
  }
  if (error instanceof Error && error.name === "AbortError") return error;

  const status = statusOf(error);
  if (status === 401) {
    return new LlmConfigurationError(
      "Invalid LLM API key. Please check LLM_API_KEY, OPENROUTER_API_KEY or OPENAI_API_KEY in the server environment.",
    );
  }
  const message = error instanceof Error ? error.message : String(error);
  if ((status === 400 || status === 422) && /response_format|json_schema|structured.output|strict|tool.*(?:unsupported|not.support)/i.test(message)) {
    return new LlmConfigurationError("The configured LLM endpoint/model must support strict json_schema output and tool calling.");
  }
  return new LlmProviderError(
    status === null
      ? `LLM request failed: ${message.slice(0, 500)}`
      : `LLM request failed (${status}): ${message.slice(0, 500)}`,
  );
}
