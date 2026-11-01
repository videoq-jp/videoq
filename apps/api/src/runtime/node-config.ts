import { deploymentEdition } from "@videoq/trpc/deployment";
import type { Bindings } from "../types/bindings";
import { resolveEmbeddingConfig } from "../lib/embedding-contract";

type Environment = Record<string, string | undefined>;

function required(source: Environment, key: string): string {
  const value = source[key]?.trim();
  if (!value) throw new Error(`${key} is required`);
  return value;
}

function parseURL(value: string, key: string): URL {
  try { return new URL(value); }
  catch { throw new Error(`${key} must be a valid URL`); }
}

function httpURL(value: string, key: string): string {
  const url = parseURL(value, key);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw new Error(`${key} must be an HTTP(S) URL without credentials`);
  }
  return value.replace(/\/+$/, "");
}

export function integerSetting(source: Environment, key: string, fallback: number, min: number, max: number): number {
  const value = source[key] === undefined ? fallback : Number(source[key]);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${key} must be an integer between ${min} and ${max}`);
  }
  return value;
}

/** Explicit configuration: never inherit development credentials or CF bindings. */
export function nodeBindings(source: Environment): Bindings {
  resolveEmbeddingConfig(source);
  const databaseURL = required(source, "DATABASE_URL");
  if (!["postgres:", "postgresql:"].includes(parseURL(databaseURL, "DATABASE_URL").protocol)) {
    throw new Error("DATABASE_URL must be a PostgreSQL URL");
  }
  const authSecret = required(source, "BETTER_AUTH_SECRET");
  if (authSecret.length < 32) throw new Error("BETTER_AUTH_SECRET must contain at least 32 characters");
  const encryptionKey = required(source, "USER_SECRET_ENCRYPTION_KEY");
  if (!/^[A-Za-z0-9_-]+={0,2}$/.test(encryptionKey)
    || Buffer.from(encryptionKey, "base64url").length !== 32) {
    throw new Error("USER_SECRET_ENCRYPTION_KEY must encode 32 bytes as base64url");
  }
  if (source.USE_S3_STORAGE && source.USE_S3_STORAGE !== "true") {
    throw new Error("The Node runtime requires USE_S3_STORAGE=true");
  }
  const publicURL = httpURL(required(source, "BETTER_AUTH_URL"), "BETTER_AUTH_URL");
  const reasoningEffort = source.LLM_REASONING_EFFORT || undefined;
  if (reasoningEffort && !["none", "minimal", "low", "medium", "high"].includes(reasoningEffort)) {
    throw new Error("LLM_REASONING_EFFORT must be none, minimal, low, medium or high");
  }
  const authURL = new URL(publicURL);
  if (authURL.pathname !== "/" || authURL.search || authURL.hash) throw new Error("BETTER_AUTH_URL must be an origin without a path, query or fragment");
  return {
    RUNTIME: "node", DEPLOYMENT_EDITION: deploymentEdition(source.DEPLOYMENT_EDITION || "onprem"), ENVIRONMENT: "production", DATABASE_URL: databaseURL,
    BETTER_AUTH_SECRET: authSecret, BETTER_AUTH_URL: publicURL,
    USER_SECRET_ENCRYPTION_KEY: encryptionKey,
    FRONTEND_URL: source.FRONTEND_URL || publicURL,
    CORS_ALLOW_ORIGIN: source.CORS_ALLOW_ORIGIN || publicURL,
    OAUTH_ISSUER_URL: source.OAUTH_ISSUER_URL || publicURL,
    DEFAULT_FROM_EMAIL: source.DEFAULT_FROM_EMAIL || "noreply@videoq.local",
    MAILGUN_API_KEY: source.MAILGUN_API_KEY, MAILGUN_SENDER_DOMAIN: source.MAILGUN_SENDER_DOMAIN,
    GOOGLE_CLIENT_ID: source.GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET: source.GOOGLE_CLIENT_SECRET,
    STRIPE_SECRET_KEY: source.STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET: source.STRIPE_WEBHOOK_SECRET,
    STRIPE_AUTOMATIC_TAX: source.STRIPE_AUTOMATIC_TAX || "false",
    COURSE_INVITATION_BATCH_LIMIT: source.COURSE_INVITATION_BATCH_LIMIT || "50",
    MAX_VIDEO_UPLOAD_SIZE_MB: source.MAX_VIDEO_UPLOAD_SIZE_MB || "200",
    DEFAULT_STORAGE_LIMIT_GB: source.DEFAULT_STORAGE_LIMIT_GB || "",
    DEFAULT_PROCESSING_LIMIT_MINUTES: source.DEFAULT_PROCESSING_LIMIT_MINUTES || "",
    DEFAULT_MONTHLY_UPLOAD_LIMIT_GB: source.DEFAULT_MONTHLY_UPLOAD_LIMIT_GB,
    DEFAULT_AI_ANSWERS_LIMIT: source.DEFAULT_AI_ANSWERS_LIMIT || "",
    OPENROUTER_API_KEY: source.OPENROUTER_API_KEY,
    OPENROUTER_FEDERATION_POLICY_ID: source.OPENROUTER_FEDERATION_POLICY_ID,
    OPENROUTER_FEDERATION_AUDIENCE: source.OPENROUTER_FEDERATION_AUDIENCE,
    OPENAI_API_KEY: source.OPENAI_API_KEY, OPENAI_BASE_URL: source.OPENAI_BASE_URL,
    LLM_API_KEY: source.LLM_API_KEY, LLM_BASE_URL: source.LLM_BASE_URL,
    LLM_MODEL: source.LLM_MODEL || "gpt-6-luna",
    LLM_REASONING_EFFORT: reasoningEffort as Bindings["LLM_REASONING_EFFORT"],
    LLM_SEPARATE_TOOL_SCHEMA: source.LLM_SEPARATE_TOOL_SCHEMA || "false",
    LLM_PRESERVE_TOOL_REASONING: source.LLM_PRESERVE_TOOL_REASONING || "false",
    LLM_REQUEST_TIMEOUT_MS: String(integerSetting(source, "LLM_REQUEST_TIMEOUT_MS", 120_000, 1000, 900_000)),
    LLM_STREAM_TIMEOUT_MS: String(integerSetting(source, "LLM_STREAM_TIMEOUT_MS", 300_000, 1000, 900_000)),
    EMBEDDING_BASE_URL: source.EMBEDDING_BASE_URL, EMBEDDING_API_KEY: source.EMBEDDING_API_KEY,
    EMBEDDING_MODEL: source.EMBEDDING_MODEL || "",
    EMBEDDING_PROFILE: source.EMBEDDING_PROFILE || "openai",
    PGVECTOR_COLLECTION_NAME: source.PGVECTOR_COLLECTION_NAME || (source.EMBEDDING_PROFILE === "embeddinggemma2" ? "scene_embeddings_768" : "scene_embeddings"),
    VIDEO_VISUAL_ENABLED: source.VIDEO_VISUAL_ENABLED || "true",
    USE_S3_STORAGE: "true",
    R2_ACCESS_KEY_ID: required(source, "R2_ACCESS_KEY_ID"),
    R2_SECRET_ACCESS_KEY: required(source, "R2_SECRET_ACCESS_KEY"),
    R2_BUCKET_NAME: required(source, "R2_BUCKET_NAME"),
    R2_S3_REGION: source.R2_S3_REGION || "auto",
    R2_S3_ENDPOINT: httpURL(required(source, "R2_S3_ENDPOINT"), "R2_S3_ENDPOINT"),
    R2_S3_INTERNAL_ENDPOINT: source.R2_S3_INTERNAL_ENDPOINT
      ? httpURL(source.R2_S3_INTERNAL_ENDPOINT, "R2_S3_INTERNAL_ENDPOINT") : undefined,
    SQS_QUEUE_URL: httpURL(required(source, "SQS_QUEUE_URL"), "SQS_QUEUE_URL"),
    AWS_REGION: source.AWS_REGION || "us-east-1",
    AWS_ACCESS_KEY_ID: required(source, "AWS_ACCESS_KEY_ID"),
    AWS_SECRET_ACCESS_KEY: required(source, "AWS_SECRET_ACCESS_KEY"),
    AWS_SESSION_TOKEN: source.AWS_SESSION_TOKEN,
  };
}
