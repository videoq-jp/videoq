type EmbeddingConfigCase = {
  env: Record<string, string>;
  expected: { provider: "openai"; model: string };
};

export const embeddingConfigCases: EmbeddingConfigCase[] = [
  { env: {}, expected: { provider: "openai", model: "text-embedding-3-small" } },
  { env: { EMBEDDING_MODEL: "  " }, expected: { provider: "openai", model: "text-embedding-3-small" } },
  { env: { EMBEDDING_MODEL: " CustomModel " }, expected: { provider: "openai", model: "CustomModel" } },
];
