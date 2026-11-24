import { DEFAULT_EMBEDDING_MODEL, LlmConfigurationError, LlmProviderError } from "./openai";
import { EMBEDDING_DIMENSIONS } from "./embedding-dimensions";

export { EMBEDDING_DIMENSIONS };

export type EmbeddingConfig = { provider: "openai" | "workers-ai"; model: string; profile?: "embeddinggemma2" };
export const WORKERS_AI_EMBEDDING_MODEL = "@cf/google/embeddinggemma-2";
export type EmbeddingSettings = { EMBEDDING_PROVIDER?: string; EMBEDDING_PROFILE?: string; EMBEDDING_MODEL?: string; EMBEDDING_BASE_URL?: string; OPENAI_BASE_URL?: string };

export const embeddingDimensions = (config?: EmbeddingConfig): number => config?.profile === "embeddinggemma2" ? 768 : EMBEDDING_DIMENSIONS;
export const embeddingTable = (config: EmbeddingConfig): "scene_embeddings" | "scene_embeddings_768" => config.profile === "embeddinggemma2" ? "scene_embeddings_768" : "scene_embeddings";
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
  const provider = env.EMBEDDING_PROVIDER?.trim() || "openai";
  if (!["openai", "workers-ai"].includes(provider)) {
    throw new EmbeddingConfigurationError("EMBEDDING_CONFIG_INVALID", "EMBEDDING_PROVIDER must be openai or workers-ai.");
  }
  const profile = env.EMBEDDING_PROFILE?.trim() || "openai";
  if (provider === "workers-ai") {
    if (profile !== "embeddinggemma2" || (env.EMBEDDING_MODEL?.trim() && env.EMBEDDING_MODEL.trim() !== WORKERS_AI_EMBEDDING_MODEL)) {
      throw new EmbeddingConfigurationError("EMBEDDING_CONFIG_INVALID", "Workers AI embeddings require the embeddinggemma2 profile and @cf/google/embeddinggemma-2 model.");
    }
    return { provider, model: WORKERS_AI_EMBEDDING_MODEL, profile };
  }
  if (!["openai", "embeddinggemma2"].includes(profile)) {
    throw new EmbeddingConfigurationError("EMBEDDING_CONFIG_INVALID", "EMBEDDING_PROFILE must be openai or embeddinggemma2.");
  }
  if (profile === "embeddinggemma2" && (!env.EMBEDDING_MODEL?.trim() || !env.EMBEDDING_BASE_URL?.trim())) {
    throw new EmbeddingConfigurationError("EMBEDDING_CONFIG_INVALID", "EmbeddingGemma 2 requires EMBEDDING_MODEL and a dedicated EMBEDDING_BASE_URL.");
  }
  const model = env.EMBEDDING_MODEL?.trim() || DEFAULT_EMBEDDING_MODEL;
  return { provider: "openai", model: model, ...(profile === "embeddinggemma2" ? { profile } : {}) };
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
  return value as number[];
}
