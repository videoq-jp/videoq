import { describe, expect, it } from "vitest";
import { nodeBindings } from "../src/runtime/node-config";
import { requestClientIp } from "../src/runtime/node-app";

export const runtimeEnvironment = {
  DATABASE_URL: "postgresql://postgres@127.0.0.1:55439/postgres",
  BETTER_AUTH_URL: "https://videoq.example.edu",
  BETTER_AUTH_SECRET: "a".repeat(48), USER_SECRET_ENCRYPTION_KEY: "AQ".repeat(21) + "A",
  R2_ACCESS_KEY_ID: "test-storage-key", R2_SECRET_ACCESS_KEY: "test-storage-secret",
  R2_S3_ENDPOINT: "https://s3.example.edu", R2_BUCKET_NAME: "videoq-media",
  SQS_QUEUE_URL: "http://queue:9324/000000000000/videoq-jobs",
  AWS_ACCESS_KEY_ID: "test-queue-key", AWS_SECRET_ACCESS_KEY: "test-queue-secret",
};

describe("Node runtime configuration and proxy boundary", () => {
  it("passes optional LTI configuration and signing keys without enabling unconfigured deployments", () => {
    const lti = { LTI_CONFIG: '{"toolOrigin":"https://api.example","databaseRegistrations":true,"registrations":[]}', LTI_TOOL_KEYS: "fixture-key-ring" };
    expect(nodeBindings({ ...runtimeEnvironment, ...lti })).toMatchObject(lti);
    expect(nodeBindings(runtimeEnvironment).LTI_CONFIG).toBeUndefined();
    expect(nodeBindings(runtimeEnvironment).LTI_TOOL_KEYS).toBeUndefined();
  });
  it("uses production auth protections and configurable local inference without CF resources", () => {
    const env = nodeBindings({ ...runtimeEnvironment,
      OPENROUTER_API_KEY: "shared-router-key", LLM_BASE_URL: "https://openrouter.ai/api/v1", LLM_API_KEY: "router-key",
      EMBEDDING_MODEL: "gte-qwen2-1.5b-q4km-124fbdad",
      OPENAI_BASE_URL: "http://llm:8000/v1", EMBEDDING_BASE_URL: "http://embedding:8000/v1", EMBEDDING_API_KEY: "embedding-key", LLM_REASONING_EFFORT: "none" });
    expect(env).toMatchObject({ RUNTIME: "node", ENVIRONMENT: "production", USE_S3_STORAGE: "true",
      OPENROUTER_API_KEY: "shared-router-key", LLM_BASE_URL: "https://openrouter.ai/api/v1", LLM_API_KEY: "router-key",
      CORS_ALLOW_ORIGIN: runtimeEnvironment.BETTER_AUTH_URL,
      OPENAI_BASE_URL: "http://llm:8000/v1", EMBEDDING_BASE_URL: "http://embedding:8000/v1", EMBEDDING_API_KEY: "embedding-key", LLM_REASONING_EFFORT: "none" });
    expect(env.HYPERDRIVE).toBeUndefined();
    expect(env.VIDEO_BUCKET).toBeUndefined();
  });

  it.each(["DATABASE_URL", "BETTER_AUTH_SECRET", "USER_SECRET_ENCRYPTION_KEY", "R2_ACCESS_KEY_ID",
    "R2_SECRET_ACCESS_KEY", "SQS_QUEUE_URL", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"])(
    "rejects a missing %s instead of using development defaults", key => {
      expect(() => nodeBindings({ ...runtimeEnvironment, [key]: "" })).toThrow(key);
    });
  it.each([
    { BETTER_AUTH_SECRET: "short" }, { USER_SECRET_ENCRYPTION_KEY: "invalid" },
    { USE_S3_STORAGE: "false" }, { DATABASE_URL: "https://database" },
    { R2_S3_ENDPOINT: "file:///tmp/object" }, { BETTER_AUTH_URL: "https://example.edu/prefix" },
    { LLM_REASONING_EFFORT: "unsupported" },
  ])("rejects invalid configuration %j", overrides => {
    expect(() => nodeBindings({ ...runtimeEnvironment, ...overrides })).toThrow();
  });

  it("ignores spoofed headers by default and uses the exact trusted proxy depth", () => {
    const request = new Request("http://api/health", { headers: {
      "x-forwarded-for": "198.51.100.99, 203.0.113.2, 10.0.0.2",
      "cf-connecting-ip": "198.51.100.99", "x-videoq-client-ip": "198.51.100.99",
    } });
    expect(requestClientIp(request, "10.0.0.3", 0)).toBe("10.0.0.3");
    expect(requestClientIp(request, "10.0.0.3", 1)).toBe("10.0.0.2");
    expect(requestClientIp(request, "10.0.0.3", 2)).toBe("203.0.113.2");
    expect(requestClientIp(request, "10.0.0.3", 9)).toBe("10.0.0.3");
    expect(requestClientIp(new Request("http://api"), "::1", 1)).toBe("::1");
  });
});
