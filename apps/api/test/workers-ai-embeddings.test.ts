import { afterEach, describe, expect, it, vi } from "vitest";
import { embedQuery, embedTexts } from "../src/lib/embeddings";
import { resolveEmbeddingConfig, WORKERS_AI_EMBEDDING_MODEL } from "../src/lib/embedding-contract";

const vector = [1, ...Array(767).fill(0)];
const settings = { EMBEDDING_PROVIDER: "workers-ai", EMBEDDING_PROFILE: "embeddinggemma2" };
function binding() {
  return { run: vi.fn(async (_model: unknown, args: { input: string[] }, _options?: unknown) => Response.json({
    data: args.input.map((_, index) => ({ index, embedding: vector })), usage: { prompt_tokens: 10, total_tokens: 10 },
  })) };
}
afterEach(() => vi.restoreAllMocks());

describe("Workers AI embeddings through LangChain", () => {
  it("resolves an explicit provider without an API key or endpoint", () => {
    expect(resolveEmbeddingConfig(settings)).toEqual({ provider: "workers-ai", profile: "embeddinggemma2", model: WORKERS_AI_EMBEDDING_MODEL });
  });
  it.each([
    { EMBEDDING_PROVIDER: "other" },
    { EMBEDDING_PROVIDER: "workers-ai" },
    { ...settings, EMBEDDING_MODEL: "other" },
  ])("rejects incompatible configuration %j", env => {
    expect(() => resolveEmbeddingConfig(env)).toThrowError(expect.objectContaining({ reason: "EMBEDDING_CONFIG_INVALID" }));
  });
  it("uses the binding and query prefix, preserving newlines and usage", async () => {
    const AI = binding();
    const complete = vi.fn();
    const begin = vi.fn(() => ({ complete, fail: vi.fn(), interrupt: vi.fn() }));
    expect(await embedQuery({ ...settings, AI: AI as unknown as Pick<Ai, "run"> }, "標本化\nとは", undefined, { begin })).toEqual(vector);
    expect(AI.run).toHaveBeenCalledWith(WORKERS_AI_EMBEDDING_MODEL, {
      input: ["task: search result | query: 標本化\nとは"], dimensions: 768, encoding_format: "float",
    }, expect.objectContaining({ returnRawResponse: true, signal: expect.any(AbortSignal) }));
    expect(begin).toHaveBeenCalledWith("query_embedding", WORKERS_AI_EMBEDDING_MODEL);
    expect(complete).toHaveBeenCalledWith({ prompt_tokens: 10, total_tokens: 10 });
  });
  it("uses LangChain batching and keeps document order", async () => {
    const AI = binding();
    const texts = Array.from({ length: 33 }, (_, index) => `document ${index}`);
    expect(await embedTexts({ ...settings, AI: AI as unknown as Pick<Ai, "run"> }, texts, "document")).toEqual(texts.map(() => vector));
    expect(AI.run).toHaveBeenCalledTimes(2);
    expect(AI.run.mock.calls[0][1].input).toEqual(texts.slice(0, 32).map(text => `title: none | text: ${text}`));
    expect(AI.run.mock.calls[1][1].input).toEqual(["title: none | text: document 32"]);
  });
  it.each([
    { data: [] }, { data: [{ index: 1, embedding: vector }] },
    { data: [{ index: 0, embedding: [1, 2] }] }, { data: [{ index: 0, embedding: Array(768).fill(0) }] },
  ])("rejects invalid provider output %j", async payload => {
    const run = vi.fn(async () => Response.json(payload));
    await expect(embedQuery({ ...settings, AI: { run } as unknown as Pick<Ai, "run"> }, "query"))
      .rejects.toMatchObject({ reason: "EMBEDDING_OUTPUT_INVALID" });
    expect(run).toHaveBeenCalledOnce();
  });
  it("does not start provider work for an already aborted request", async () => {
    const AI = binding();
    const controller = new AbortController();
    const reason = new DOMException("Disconnected", "AbortError");
    controller.abort(reason);
    await expect(embedQuery({ ...settings, AI: AI as unknown as Pick<Ai, "run"> }, "query", controller.signal)).rejects.toBe(reason);
    expect(AI.run).not.toHaveBeenCalled();
  });
  it("requires an AI binding", async () => {
    await expect(embedQuery(settings, "query")).rejects.toThrow("require the AI binding");
  });
  it("preserves caller cancellation", async () => {
    const controller = new AbortController();
    const started = Promise.withResolvers<void>();
    const run = vi.fn((_model: unknown, _input: unknown, options: { signal: AbortSignal }) => new Promise<Response>((_resolve, reject) => {
      options.signal.addEventListener("abort", () => reject(options.signal.reason instanceof Error ? options.signal.reason : new Error("Aborted")), { once: true });
      started.resolve();
    }));
    const pending = embedQuery({ ...settings, AI: { run } as unknown as Pick<Ai, "run"> }, "query", controller.signal);
    const reason = new DOMException("Disconnected", "AbortError");
    const assertion = expect(pending).rejects.toBe(reason);
    await started.promise;
    controller.abort(reason);
    await assertion;
    expect(run).toHaveBeenCalledOnce();
  });
  it("sanitizes provider errors and does not retry on bad requests", async () => {
    const run = vi.fn(async () => new Response("private text", { status: 400 }));
    await expect(embedQuery({ ...settings, AI: { run } as unknown as Pick<Ai, "run"> }, "query"))
      .rejects.toThrow("Workers AI embeddings request failed");
    expect(run).toHaveBeenCalledOnce();
  });
});
