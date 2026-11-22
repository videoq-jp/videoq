import { EmbeddingValidationError, validateEmbedding, WORKERS_AI_EMBEDDING_MODEL, type EmbeddingConfig } from "./embedding-contract";

/** Temporary OpenAI protocol bridge; replace with upstream Cloudflare embeddings support. */
export function workersAiEmbeddingFetch(
  binding: Pick<Ai, "run">,
  config: EmbeddingConfig,
  signal: AbortSignal,
  onUsage?: (usage: unknown) => void,
): typeof fetch {
  return async (input, init) => {
    const request = new Request(input, init);
    const combinedSignal = AbortSignal.any([request.signal, signal]);
    combinedSignal.throwIfAborted();
    if (request.method !== "POST" || new URL(request.url).pathname !== "/v1/embeddings") {
      return Response.json({ error: { message: "Unsupported Workers AI operation" } }, { status: 400 });
    }
    const body = await request.json<{ model: string; input: string | string[]; dimensions: number; encoding_format: "float" }>();
    if (body.model !== WORKERS_AI_EMBEDDING_MODEL || body.dimensions !== 768 || body.encoding_format !== "float" ||
        !(typeof body.input === "string" || (Array.isArray(body.input) && body.input.every(text => typeof text === "string")))) {
      return Response.json({ error: { message: "Unsupported Workers AI embedding parameters" } }, { status: 400 });
    }
    const response = await binding.run(WORKERS_AI_EMBEDDING_MODEL, {
      input: body.input, dimensions: body.dimensions, encoding_format: body.encoding_format,
    }, { returnRawResponse: true, signal: combinedSignal });
    if (!(response instanceof Response)) throw new EmbeddingValidationError("EMBEDDING_OUTPUT_INVALID", config);
    if (!response.ok) return response;
    const payload = await response.json<{ data?: { index: number; embedding: unknown }[]; usage?: unknown }>();
    const count = typeof body.input === "string" ? 1 : body.input.length;
    if (!Array.isArray(payload.data) || payload.data.length !== count) throw new EmbeddingValidationError("EMBEDDING_OUTPUT_INVALID", config);
    for (const [index, item] of payload.data.entries()) {
      if (item.index !== index) throw new EmbeddingValidationError("EMBEDDING_OUTPUT_INVALID", config);
      validateEmbedding(item.embedding, "EMBEDDING_OUTPUT_INVALID", config);
    }
    combinedSignal.throwIfAborted();
    onUsage?.(payload.usage);
    return Response.json(payload);
  };
}
