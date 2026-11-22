import { workersAiFetch, WORKERS_AI_LLM_MODEL } from "./workers-ai-transport";
import { federatedOpenRouterToken, type FederationSettings } from "./openrouter-federation";
import type { Bindings } from "../types/bindings";

/**
 * OpenAI 呼び出しの共通部（埋め込み / チャット生成）。
 * VideoQ の OpenAI API キー解決とエラー分類。
 *   - キー未設定           → LlmConfigurationError（HTTP 400 / SSE LLM_CONFIGURATION_ERROR）
 *   - 401（キー不正）      → LlmConfigurationError
 *   - その他の失敗         → LlmProviderError（HTTP 500 でマスク / SSE LLM_PROVIDER_ERROR）
 */
export class LlmConfigurationError extends Error {
  readonly name = "LlmConfigurationError";
}

export class LlmProviderError extends Error {
  readonly name = "LlmProviderError";
}

export const DEFAULT_EMBEDDING_MODEL = "text-embedding-3-small";
export const DEFAULT_LLM_MODEL = "gpt-6-luna";
export { WORKERS_AI_LLM_MODEL };

const DEFAULT_BASE_URL = "https://api.openai.com/v1";

export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
type ConnectionSettings = Pick<Bindings, "OPENAI_API_KEY" | "OPENAI_BASE_URL" | "OPENROUTER_API_KEY"> & FederationSettings;
export type ProviderCredential = string | (() => Promise<string>);

export function isOpenRouter(baseURL: string): boolean {
  try { return new URL(baseURL).hostname === "openrouter.ai"; }
  catch { return false; }
}

/** Preserve custom/local model aliases; only qualify the existing hosted models. */
export function providerModel(model: string, baseURL: string): string {
  return isOpenRouter(baseURL) && [DEFAULT_LLM_MODEL, DEFAULT_EMBEDDING_MODEL].includes(model)
    ? `openai/${model}` : model;
}

export const openAiBaseUrl = (env: Pick<Bindings, "OPENAI_BASE_URL" | "OPENROUTER_API_KEY" | "OPENROUTER_FEDERATION_POLICY_ID">): string => {
  const value = env.OPENAI_BASE_URL || ((env.OPENROUTER_API_KEY || env.OPENROUTER_FEDERATION_POLICY_ID) ? OPENROUTER_BASE_URL : DEFAULT_BASE_URL);
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 47) end--;
  return value.slice(0, end);
};

/** Shared credentials follow the selected endpoint; explicit purpose keys take precedence. */
export function resolveOpenAiKey(env: ConnectionSettings, purpose: string, baseURL = openAiBaseUrl(env)): ProviderCredential {
  if (isOpenRouter(baseURL) && env.OPENROUTER_FEDERATION_POLICY_ID) return () => federatedOpenRouterToken(env);
  // A stale direct OpenAI key must never be forwarded to OpenRouter during rollout.
  const key = isOpenRouter(baseURL) ? env.OPENROUTER_API_KEY : env.OPENAI_API_KEY;
  if (!key) {
    throw new LlmConfigurationError(
      `API key is required when using ${purpose}. Set OPENROUTER_API_KEY for OpenRouter or OPENAI_API_KEY for OpenAI.`,
    );
  }
  return key;
}

/** The Workers AI credential is dedicated; never send legacy provider keys there. */
export function isWorkersAi(baseURL: string): boolean {
  try {
    const url = new URL(baseURL);
    return url.origin === "https://api.cloudflare.com" && /^\/client\/v4\/accounts\/[^/]+\/ai\/v1\/?$/.test(url.pathname);
  } catch { return false; }
}

/** Gemma uses its chat-template switch instead of OpenAI reasoning_effort. */
export function llmReasoningEffort(env: Pick<Bindings, "LLM_REASONING_EFFORT">, model: string): Bindings["LLM_REASONING_EFFORT"] {
  if (model === WORKERS_AI_LLM_MODEL) return undefined;
  return env.LLM_REASONING_EFFORT || (["gpt-6-luna", "openai/gpt-6-luna"].includes(model) ? "none" : undefined);
}

/** Gemma's thinking is unnecessary for bounded evidence extraction and answers. */
export function llmModelKwargs(model: string): Record<string, unknown> {
  return model === WORKERS_AI_LLM_MODEL ? { chat_template_kwargs: { enable_thinking: false } } : {};
}

/** A shared output budget for answers, summaries and image observations. */
export function llmMaxTokens(env: Pick<Bindings, "LLM_MAX_TOKENS" | "LLM_BASE_URL" | "LLM_MODEL">, fallback?: number): number | undefined {
  if (!env.LLM_MAX_TOKENS) return env.LLM_MODEL === WORKERS_AI_LLM_MODEL || isWorkersAi(env.LLM_BASE_URL || "") ? 4096 : fallback;
  const value = Number(env.LLM_MAX_TOKENS);
  if (!Number.isSafeInteger(value) || value < 1024 || value > 32768) {
    throw new LlmConfigurationError("LLM_MAX_TOKENS must be an integer between 1024 and 32768.");
  }
  return value;
}

/** Answer generation and image inspection share a connection, with optional overrides. */
export function resolveLlmConnection(
  env: ConnectionSettings & Pick<Bindings, "LLM_API_KEY" | "LLM_BASE_URL" | "LLM_MODEL" | "AI">,
): { apiKey: ProviderCredential; baseURL: string; fetch?: typeof fetch } {
  if (env.LLM_MODEL === WORKERS_AI_LLM_MODEL && !env.LLM_BASE_URL) {
    if (!env.AI) throw new LlmConfigurationError("Gemma requires the AI binding or LLM_BASE_URL and LLM_API_KEY.");
    return { apiKey: "workers-ai-binding", baseURL: "https://workers-ai.internal/v1", fetch: workersAiFetch(env.AI) };
  }
  const baseURL = (env.LLM_BASE_URL || openAiBaseUrl(env)).replace(/\/+$/, "");
  if (isWorkersAi(baseURL) && !env.LLM_API_KEY) {
    throw new LlmConfigurationError("Workers AI requires a dedicated LLM_API_KEY.");
  }
  const apiKey = isOpenRouter(baseURL) && env.OPENROUTER_FEDERATION_POLICY_ID
    ? resolveOpenAiKey(env, "LLM", baseURL)
    : env.LLM_API_KEY || resolveOpenAiKey(env, "LLM", baseURL);
  return { apiKey, baseURL };
}
