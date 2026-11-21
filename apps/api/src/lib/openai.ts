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

export const openAiBaseUrl = (env: Pick<Bindings, "OPENAI_BASE_URL" | "OPENROUTER_API_KEY" | "OPENROUTER_FEDERATION_POLICY_ID">): string =>
  (env.OPENAI_BASE_URL || ((env.OPENROUTER_API_KEY || env.OPENROUTER_FEDERATION_POLICY_ID) ? OPENROUTER_BASE_URL : DEFAULT_BASE_URL)).replace(/\/+$/, "");

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

/** Answer generation and image inspection share a connection, with optional overrides. */
export function resolveLlmConnection(
  env: ConnectionSettings & Pick<Bindings, "LLM_API_KEY" | "LLM_BASE_URL">,
): { apiKey: ProviderCredential; baseURL: string } {
  const baseURL = (env.LLM_BASE_URL || openAiBaseUrl(env)).replace(/\/+$/, "");
  const apiKey = isOpenRouter(baseURL) && env.OPENROUTER_FEDERATION_POLICY_ID
    ? resolveOpenAiKey(env, "LLM", baseURL)
    : env.LLM_API_KEY || resolveOpenAiKey(env, "LLM", baseURL);
  return { apiKey, baseURL };
}
