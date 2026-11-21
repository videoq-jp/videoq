import { URL } from "node:url";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { unstable_getVarsForDev, unstable_readConfig } from "wrangler";
import { describe, expect, it } from "vitest";
import { embeddingDimensions, resolveEmbeddingConfig, type EmbeddingConfig, type EmbeddingSettings } from "../src/lib/embedding-contract";

const configPath = fileURLToPath(new URL("../wrangler.jsonc", import.meta.url));
const native: EmbeddingConfig = { provider: "workers-ai", model: "@cf/google/embeddinggemma-2", profile: "embeddinggemma2" };
const cases: { env: Record<string, string>; expected: EmbeddingConfig; dimensions: number }[] = [
  { env: {}, expected: native, dimensions: 768 },
  // Stale credentials/endpoints cannot silently replace the selected native provider.
  { env: { OPENROUTER_API_KEY: "router-key", OPENAI_BASE_URL: "https://openrouter.ai/api/v1" }, expected: native, dimensions: 768 },
  { env: { EMBEDDING_PROVIDER: "openai", EMBEDDING_MODEL: "embeddinggemma-2-f9972ac", EMBEDDING_BASE_URL: "http://private-embedding:8000/v1" },
    expected: { provider: "openai", model: "embeddinggemma-2-f9972ac", profile: "embeddinggemma2" }, dimensions: 768 },
  { env: { EMBEDDING_PROVIDER: "openai", EMBEDDING_PROFILE: "openai", EMBEDDING_MODEL: "text-embedding-3-small", EMBEDDING_BASE_URL: "https://api.openai.com/v1" },
    expected: { provider: "openai", model: "text-embedding-3-small" }, dimensions: 1536 },
];

function mergedSettings(environment: string | undefined, overrides: Record<string, string>): EmbeddingSettings {
  const config = unstable_readConfig({ config: configPath, env: environment });
  const directory = mkdtempSync(join(tmpdir(), "videoq-embedding-settings-"));
  try {
    // Use a disposable file so the developer's .dev.vars and credentials never
    // influence this test. Retain all provider/profile fields used at runtime.
    writeFileSync(join(directory, ".dev.vars"), Object.entries(overrides)
      .map(([key, value]) => `${key}=${JSON.stringify(value)}`).join("\n"));
    const bindings = unstable_getVarsForDev(
      join(directory, "wrangler.jsonc"), undefined, config.vars, environment, true,
    );
    return Object.fromEntries(Object.entries(bindings).map(([key, binding]) => [key, String(binding.value ?? "")]));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe.each([undefined, "production"])("Wrangler embedding settings (%s)", (environment) => {
  it.each(cases)("resolves merged overrides $env", ({ env, expected, dimensions }) => {
    const actual = resolveEmbeddingConfig(mergedSettings(environment, env));
    expect(actual).toEqual(expected);
    expect(embeddingDimensions(actual)).toBe(dimensions);
  });

  it.each([{ EMBEDDING_MODEL: "  " }, { EMBEDDING_PROFILE: "openai" }])("rejects incomplete native overrides %s", (overrides) => {
    expect(() => resolveEmbeddingConfig(mergedSettings(environment, overrides))).toThrow("Workers AI requires");
  });
});
