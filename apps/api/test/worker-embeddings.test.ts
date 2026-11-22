import { Hono } from "hono";
import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { workerInternalRoutes } from "../src/features/worker-internal/routes";
import type { AppEnv, Bindings } from "../src/types/bindings";

const app = new Hono<AppEnv>().route("/internal/worker", workerInternalRoutes);
const secret = "worker-test-key-0123456789-abcdefghijklmnop";
const path = "/internal/worker/embeddings/generate";
const origin = "https://api.example.test";
const model = "@cf/google/embeddinggemma-2";
const input = { model, profile: "embeddinggemma2", dimensions: 768, inputType: "document", texts: ["標本化", "量子化"] };
function request(payload: unknown, signed = true) {
  const body = JSON.stringify(payload), timestamp = String(Math.floor(Date.now() / 1000));
  const signature = createHmac("sha256", secret).update(`videoq-worker-v1\n${timestamp}\nPOST\n${origin}\n${path}\n${body}`).digest("hex");
  return new Request(origin + path, { method: "POST", body, headers: signed ? {
    "x-videoq-worker-timestamp": timestamp,
    "x-videoq-worker-signature": signature,
  } : {} });
}
const vector = [1, ...Array(767).fill(0)];
function environment() {
  const run = vi.fn().mockResolvedValue(Response.json({ object: "list", model, data: [0, 1].map(index => ({ index, embedding: vector })), usage: { prompt_tokens: 5, total_tokens: 5 } }));
  const env = { WORKER_INTERNAL_API_SECRET: secret, EMBEDDING_PROVIDER: "workers-ai", EMBEDDING_PROFILE: "embeddinggemma2", EMBEDDING_MODEL: model, AI: { run } } as unknown as Bindings;
  return { run, env };
}
describe("signed worker embeddings using the actual LangChain adapter", () => {
  it("authenticates and embeds raw documents with one shared prefix", async () => {
    const { env, run } = environment();
    const result = await app.fetch(request(input), env);
    expect(result.status).toBe(200);
    expect(await result.json()).toEqual({ model, profile: "embeddinggemma2", dimensions: 768, embeddings: [vector, vector] });
    expect(run.mock.calls[0][1]).toMatchObject({ input: ["title: none | text: 標本化", "title: none | text: 量子化"], dimensions: 768 });
    expect(result.headers.get("cache-control")).toBe("no-store");
  });
  it("does not infer for unauthorized, invalid or mismatched requests", async () => {
    const { env, run } = environment();
    expect((await app.fetch(request(input, false), env)).status).toBe(401);
    for (const change of [{ dimensions: 1536 }, { texts: [] }, { texts: Array(33).fill("x") }, { texts: ["x".repeat(16_001)] }, { unexpected: true }]) {
      expect((await app.fetch(request({ ...input, ...change }), env)).status).toBe(400);
    }
    expect((await app.fetch(request(input), { ...env, EMBEDDING_PROVIDER: "openai", EMBEDDING_PROFILE: "openai" })).status).toBe(409);
    expect(run).not.toHaveBeenCalled();
  });
  it("sanitizes inference failures without returning partial vectors", async () => {
    const { env, run } = environment(); run.mockRejectedValue(new Error("private provider response"));
    const result = await app.fetch(request(input), env);
    expect(result.status).toBe(503);
    expect(await result.json()).toEqual({ error: "EMBEDDING_UNAVAILABLE" });
  });
});
