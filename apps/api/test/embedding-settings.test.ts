import { URL } from "node:url";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { unstable_getVarsForDev, unstable_readConfig } from "wrangler";
import { describe, expect, it } from "vitest";
import { resolveEmbeddingConfig } from "../src/lib/embedding-contract";
import { embeddingConfigCases } from "./helpers/embedding-config";

const configPath = fileURLToPath(new URL("../wrangler.jsonc", import.meta.url));

describe.each([undefined, "production"])("Wrangler embedding settings (%s)", (environment) => {
  it.each(embeddingConfigCases)("resolves merged overrides $env", (testCase) => {
    const config = unstable_readConfig({ config: configPath, env: environment });
    const directory = mkdtempSync(join(tmpdir(), "videoq-embedding-settings-"));
    try {
      // Load a disposable file so the developer's .dev.vars and credentials
      // never influence this configuration integration test.
      writeFileSync(join(directory, ".dev.vars"), Object.entries(testCase.env)
        .map(([key, value]) => `${key}=${JSON.stringify(value)}`).join("\n"));
      const bindings = unstable_getVarsForDev(
        join(directory, "wrangler.jsonc"), undefined, config.vars, environment, true,
      );
      const settings = {
        EMBEDDING_MODEL: String(bindings.EMBEDDING_MODEL?.value ?? ""),
        OPENAI_BASE_URL: String(bindings.OPENAI_BASE_URL?.value ?? ""),
        EMBEDDING_BASE_URL: String(bindings.EMBEDDING_BASE_URL?.value ?? ""),
        OPENROUTER_API_KEY: String(bindings.OPENROUTER_API_KEY?.value ?? ""),
      };
      expect(resolveEmbeddingConfig(settings)).toEqual({
        ...testCase.expected,
        // Wrangler selects the hosted OpenRouter profile even without a dev override.
        model: testCase.expected.model === "text-embedding-3-small"
          ? "openai/text-embedding-3-small" : testCase.expected.model,
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
