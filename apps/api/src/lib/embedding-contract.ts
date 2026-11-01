import { DEFAULT_EMBEDDING_MODEL, LlmConfigurationError, LlmProviderError, openAiBaseUrl, providerModel } from "./openai";
import { EMBEDDING_DIMENSIONS } from "./embedding-dimensions";

export { EMBEDDING_DIMENSIONS };

export type EmbeddingConfig = { provider: "openai"; model: string; profile?: "embeddinggemma2" };
export type EmbeddingSettings = { EMBEDDING_PROFILE?: string; EMBEDDING_MODEL?: string; EMBEDDING_BASE_URL?: string; OPENAI_BASE_URL?: string; OPENROUTER_API_KEY?: string; OPENROUTER_FEDERATION_POLICY_ID?: string };

export const embeddingDimensions = (config?: EmbeddingConfig): number => config?.profile === "embeddinggemma2" ? 768 : EMBEDDING_DIMENSIONS;
export const embeddingTable = (config: EmbeddingConfig): string => config.profile === "embeddinggemma2" ? "scene_embeddings_768" : "scene_embeddings";
export type EmbeddingReason =
  | "EMBEDDING_CONFIG_INVALID"
  | "EMBEDDING_SCHEMA_MISMATCH"
  | "EMBEDDING_OUTPUT_INVALID";

export function embeddingDiagnostic(
  config: EmbeddingConfig | undefined,
  details: { reason?: EmbeddingReason; db_dimensions?: number | null; actual_dimensions?: number | null } = {},
) {
  return { event: "embedding.validation", ...config, expected_dimensions: embeddingDimensions(config), ...details };
}

export class EmbeddingConfigurationError extends LlmConfigurationError {
  constructor(
    readonly reason: "EMBEDDING_CONFIG_INVALID" | "EMBEDDING_SCHEMA_MISMATCH",
    message: string,
    config?: EmbeddingConfig,
    dbDimensions?: number | null,
  ) {
    super(message);
    console.error(JSON.stringify(embeddingDiagnostic(config, { reason, db_dimensions: dbDimensions })));
  }
}

export class EmbeddingValidationError extends LlmProviderError {
  constructor(
    readonly reason: "EMBEDDING_OUTPUT_INVALID",
    config?: EmbeddingConfig,
    actualDimensions?: number | null,
  ) {
    super("Embedding data is incompatible. Ask an administrator to check the model and rebuild the affected embeddings.");
    console.error(JSON.stringify(embeddingDiagnostic(config, { reason, actual_dimensions: actualDimensions })));
  }
}

export function resolveEmbeddingConfig(env: EmbeddingSettings): EmbeddingConfig {
  const profile = env.EMBEDDING_PROFILE?.trim() || "openai";
  if (!["openai", "embeddinggemma2"].includes(profile)) {
    throw new EmbeddingConfigurationError("EMBEDDING_CONFIG_INVALID", "EMBEDDING_PROFILE must be openai or embeddinggemma2.");
  }
  if (profile === "embeddinggemma2" && (!env.EMBEDDING_MODEL?.trim() || !env.EMBEDDING_BASE_URL?.trim())) {
    throw new EmbeddingConfigurationError("EMBEDDING_CONFIG_INVALID", "EmbeddingGemma 2 requires EMBEDDING_MODEL and a dedicated EMBEDDING_BASE_URL.");
  }
  const model = env.EMBEDDING_MODEL?.trim() || DEFAULT_EMBEDDING_MODEL;
  const baseURL = openAiBaseUrl({ ...env, OPENAI_BASE_URL: env.EMBEDDING_BASE_URL || env.OPENAI_BASE_URL });
  return { provider: "openai", model: providerModel(model, baseURL), ...(profile === "embeddinggemma2" ? { profile } : {}) };
}

export function validateEmbedding(
  value: unknown,
  reason: "EMBEDDING_OUTPUT_INVALID" = "EMBEDDING_OUTPUT_INVALID",
  config?: EmbeddingConfig,
): number[] {
  if (
    !Array.isArray(value) || value.length !== embeddingDimensions(config) ||
    !value.every((v: unknown) => typeof v === "number" && Number.isFinite(v) && Number.isFinite(Math.fround(v))) ||
    !value.some((v: number) => Math.fround(v) !== 0)
  ) {
    throw new EmbeddingValidationError(reason, config, Array.isArray(value) ? value.length : null);
  }
  return value;
}
