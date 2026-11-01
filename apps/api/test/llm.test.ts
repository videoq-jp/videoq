import { embedding as testEmbedding } from "./helpers/embedding";
import { describe, it, expect, afterEach, vi } from "vitest";
import { generateReply, streamReply, LLM_STREAM_TIMEOUT_MS, llmTimeoutMs } from "../src/lib/llm";
import { stalledChatResponse } from "./helpers/stalled-chat-response";
import { embedQuery } from "../src/lib/embeddings";
import { LlmConfigurationError, LlmProviderError, resolveLlmConnection } from "../src/lib/openai";
import type { Bindings } from "../src/types/bindings";

const ENV = {
  OPENAI_API_KEY: "sk-test",
  OPENAI_BASE_URL: "https://openai.test/v1",
} as unknown as Bindings;

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const sseResponse = (frames: string[]) =>
  new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        const enc = new TextEncoder();
        for (const f of frames) controller.enqueue(enc.encode(f));
        controller.close();
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const modelAnswer = { segments: [{ text: "answer", sourceIds: [] }] };
const completion = (content = JSON.stringify(modelAnswer), finish_reason = "stop", refusal?: string) => ({
  choices: [{ finish_reason, message: { role: "assistant", content, ...(refusal ? { refusal } : {}) } }],
});
const frame = (content: string, finish_reason: string | null = null) => `data: ${JSON.stringify({ choices: [{ delta: { role: "assistant", content }, finish_reason }] })}\n\n`;
const frames = () => [frame(JSON.stringify(modelAnswer)), frame("", "stop"), "data: [DONE]\n\n"];

describe("native structured LLM output", () => {
  it("falls back endpoint and credentials independently, and supports an LLM-only key", () => {
    expect(resolveLlmConnection({ LLM_API_KEY: "router", LLM_BASE_URL: "https://openrouter.ai/api/v1/" }))
      .toEqual({ apiKey: "router", baseURL: "https://openrouter.ai/api/v1" });
    expect(resolveLlmConnection({ ...ENV, LLM_API_KEY: "dedicated" }))
      .toEqual({ apiKey: "dedicated", baseURL: ENV.OPENAI_BASE_URL });
    expect(resolveLlmConnection({ ...ENV, LLM_BASE_URL: "https://llm.test/v1" }))
      .toEqual({ apiKey: "sk-test", baseURL: "https://llm.test/v1" });
    expect(resolveLlmConnection({ ...ENV, OPENROUTER_API_KEY: "router-key" })).toEqual({ apiKey: "sk-test", baseURL: ENV.OPENAI_BASE_URL });
    expect(() => resolveLlmConnection({})).toThrow(LlmConfigurationError);
  });
  it("shares one OpenRouter key for the current answer and embedding models", async () => {
    const env = { OPENROUTER_API_KEY: "router-key" } as Bindings;
    const seen: string[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      seen.push(String(url));
      expect(new Headers(init.headers).get("authorization")).toBe("Bearer router-key");
      const body = JSON.parse(String(init.body));
      if (String(url).endsWith("/embeddings")) {
        expect(body).toMatchObject({ model: "openai/text-embedding-3-small", dimensions: 1536 });
        return jsonResponse({ data: [{ index: 0, embedding: testEmbedding(1) }] });
      }
      expect(body).toMatchObject({ model: "openai/gpt-6-luna", reasoning_effort: "none", response_format: { type: "json_schema", json_schema: { strict: true } } });
      return body.stream ? sseResponse(frames()) : jsonResponse(completion());
    });
    expect(await generateReply(env, "S", "Q")).toEqual(modelAnswer);
    const chunks = [];
    for await (const chunk of streamReply(env, "S", "Q")) chunks.push(chunk);
    expect(chunks.at(-1)).toEqual({ answer: modelAnswer });
    await embedQuery(env, "Q");
    expect(seen).toEqual(["https://openrouter.ai/api/v1/chat/completions", "https://openrouter.ai/api/v1/chat/completions", "https://openrouter.ai/api/v1/embeddings"]);
  });
  it("does not forward a legacy direct OpenAI key to the OpenRouter endpoint", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const env = { ...ENV, OPENAI_BASE_URL: "https://openrouter.ai/api/v1" };
    await expect(generateReply(env, "S", "Q")).rejects.toThrow(LlmConfigurationError);
    await expect(embedQuery(env, "Q")).rejects.toThrow(LlmConfigurationError);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("routes answer and stream to the dedicated endpoint while keeping embeddings on OpenAI", async () => {
    const env = { ...ENV, LLM_BASE_URL: "https://openrouter.ai/api/v1/", LLM_API_KEY: "router-key", LLM_MODEL: "vendor/model" };
    const seen: string[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      const endpoint = String(url);
      seen.push(endpoint);
      const headers = new Headers(init.headers);
      if (endpoint.endsWith("/embeddings")) {
        expect(endpoint).toBe("https://openai.test/v1/embeddings");
        expect(headers.get("authorization")).toBe("Bearer sk-test");
        return jsonResponse({ data: [{ index: 0, embedding: testEmbedding(1) }] });
      }
      expect(endpoint).toBe("https://openrouter.ai/api/v1/chat/completions");
      expect(headers.get("authorization")).toBe("Bearer router-key");
      const body = JSON.parse(String(init.body));
      expect(body.model).toBe("vendor/model");
      expect(body.response_format.json_schema.strict).toBe(true);
      return body.stream ? sseResponse(frames()) : jsonResponse(completion());
    });
    expect(await generateReply(env, "SYS", "Q")).toEqual(modelAnswer);
    const chunks = [];
    for await (const chunk of streamReply(env, "SYS", "Q")) chunks.push(chunk);
    expect(chunks.at(-1)).toEqual({ answer: modelAnswer });
    await embedQuery(env, "Q");
    expect(seen).toHaveLength(3);
  });
  it("accepts bounded CPU inference deadlines and preserves hosted defaults", () => {
    expect(llmTimeoutMs(ENV)).toBe(120_000);
    expect(llmTimeoutMs(ENV, true)).toBe(300_000);
    const local = { ...ENV, LLM_REQUEST_TIMEOUT_MS: "600000", LLM_STREAM_TIMEOUT_MS: "600000" };
    expect(llmTimeoutMs(local)).toBe(600_000);
    expect(llmTimeoutMs(local, true)).toBe(600_000);
    for (const value of ["0", "900001", "NaN", "1.5"]) {
      expect(() => llmTimeoutMs({ ...ENV, LLM_REQUEST_TIMEOUT_MS: value })).toThrow(LlmConfigurationError);
    }
  });
  it("can disable reasoning on a local thinking model without changing the response schema", async () => {
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      expect(JSON.parse(String(init.body))).toMatchObject({ model: "qwen3:4b", reasoning_effort: "none",
        response_format: { type: "json_schema", json_schema: { strict: true } } });
      return jsonResponse(completion());
    });
    expect(await generateReply({ ...ENV, LLM_MODEL: "qwen3:4b", LLM_REASONING_EFFORT: "none" }, "SYS", "Q")).toEqual(modelAnswer);
  });
  it.each(["local-codex-model", "gpt-5.4-pro", "gpt-4o-mini", "gpt-6-luna"])("%s uses strict json_schema with no conversion call", async (model) => {
    const calls: Record<string, unknown>[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      expect(String(url)).toBe("https://openai.test/v1/chat/completions");
      const body = JSON.parse(String(init.body));
      calls.push(body);
      expect(body).toMatchObject({ model,
        response_format: { type: "json_schema", json_schema: { strict: true } },

      });
      if (model === "gpt-6-luna") {
        expect(body).toMatchObject({ reasoning_effort: "none", max_completion_tokens: 1024 });
        expect(body).not.toHaveProperty("max_tokens");
      } else {
        expect(body).not.toHaveProperty("reasoning_effort");
      }
      return body.stream ? sseResponse(frames()) : jsonResponse(completion());
    });
    expect(await generateReply({ ...ENV, LLM_MODEL: model }, "SYS", "Q")).toEqual(modelAnswer);
    const chunks = [];
    for await (const chunk of streamReply({ ...ENV, LLM_MODEL: model }, "SYS", "Q")) chunks.push(chunk);
    expect(chunks).toEqual([{ segmentIndex: 0, text: "answer" }, { answer: modelAnswer }]);
    expect(calls).toHaveLength(2);
  });
  it("joins split SSE frames and emits text before completion", async () => {
    const first = frame('{"segments":[{"text":"Hel');
    const second = frame('lo","sourceIds":[]}]}');
    vi.stubGlobal("fetch", async () => sseResponse([first, second.slice(0, 10), second.slice(10), frame("", "stop"), "data: [DONE]\n\n"]));
    const chunks = [];
    for await (const chunk of streamReply(ENV, "S", "Q")) chunks.push(chunk);
    expect(chunks).toEqual([{ segmentIndex: 0, text: "Hel" }, { segmentIndex: 0, text: "lo" }, { answer: { segments: [{ text: "Hello", sourceIds: [] }] } }]);
  });
  it("aborts the upstream when the consumer stops after receiving text", async () => {
    let upstream: AbortSignal | undefined;
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      upstream = init.signal!;
      return stalledChatResponse(upstream, () => {}, true, '{"segments":[{"text":"First');
    });
    const stream = streamReply(ENV, "S", "Q");
    try {
      expect((await stream.next()).value).toEqual({ segmentIndex: 0, text: "First" });
      await stream.return();
      expect(upstream?.aborted).toBe(true);
    } finally { await stream.return(); }
  });
  it.each(["deadline", "client"])("propagates %s cancellation while receiving the body", async (source) => {
    const deadline = new AbortController();
    const client = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
    let upstream: AbortSignal | undefined;
    const reading = Promise.withResolvers<void>();
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      upstream = init.signal!;
      return stalledChatResponse(upstream, reading.resolve);
    });
    const consume = (async () => { for await (const chunk of streamReply(ENV, "S", "Q", client.signal)) void chunk; })();
    const rejected = expect(consume).rejects.toThrow();
    await reading.promise;
    if (source === "deadline") deadline.abort(new DOMException("deadline reached", "TimeoutError"));
    else client.abort();
    await rejected;
    expect(upstream?.aborted).toBe(true);
    expect(timeout).toHaveBeenCalledWith(LLM_STREAM_TIMEOUT_MS);
  });
  it.each([
    ["not JSON", "stop", undefined], [JSON.stringify(modelAnswer), "length", undefined],
    [JSON.stringify(modelAnswer), "stop", "refused"], ["", "content_filter", undefined],
  ])("rejects malformed, truncated or refused answers without retry", async (content, reason, refusal) => {
    const fetch = vi.fn(async () => jsonResponse(completion(content, reason, refusal)));
    vi.stubGlobal("fetch", fetch);
    await expect(generateReply(ENV, "S", "Q")).rejects.toThrow(LlmProviderError);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("accepts repeated stop notifications through the library event assembler", async () => {
    vi.stubGlobal("fetch", async () => sseResponse([
      frame(JSON.stringify(modelAnswer)), frame("", "stop"), frame("", "stop"),
      `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\n`,
      "data: [DONE]\n\n",
    ]));
    const chunks = [];
    for await (const chunk of streamReply(ENV, "S", "Q")) chunks.push(chunk);
    expect(chunks).toEqual([{ segmentIndex: 0, text: "answer" }, { answer: modelAnswer }]);
  });
  it("rejects a stream without an explicit successful finish", async () => {
    vi.stubGlobal("fetch", async () => sseResponse([frame(JSON.stringify(modelAnswer)), "data: [DONE]\n\n"]));
    const consume = async () => { for await (const chunk of streamReply(ENV, "S", "Q")) void chunk; };
    await expect(consume()).rejects.toThrow(LlmProviderError);
  });
  it.each(["refusal", "length", "content_filter"])("rejects a %s stream after partial text without repairing it", async reason => {
    const delta = reason === "refusal" ? { refusal: "refused" } : {};
    const end = `data: ${JSON.stringify({ choices: [{ delta, finish_reason: reason === "refusal" ? "stop" : reason }] })}\n\n`;
    const fetch = vi.fn(async () => sseResponse([frame(JSON.stringify(modelAnswer)), end, "data: [DONE]\n\n"]));
    vi.stubGlobal("fetch", fetch);
    const chunks = [];
    const consume = async () => { for await (const chunk of streamReply(ENV, "S", "Q")) chunks.push(chunk); };
    await expect(consume()).rejects.toThrow(LlmProviderError);
    expect(chunks).toEqual([{ segmentIndex: 0, text: "answer" }]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("reports unsupported providers and authentication errors without fallback", async () => {
    vi.stubGlobal("fetch", async () => jsonResponse({ error: "json_schema unsupported" }, 400));
    await expect(generateReply(ENV, "S", "Q")).rejects.toThrow(LlmConfigurationError);
    vi.stubGlobal("fetch", async () => jsonResponse({ error: "nope" }, 401));
    await expect(generateReply(ENV, "S", "Q")).rejects.toThrow(LlmConfigurationError);
    vi.stubGlobal("fetch", async () => jsonResponse({ error: "boom" }, 500));
    await expect(generateReply(ENV, "S", "Q")).rejects.toThrow(LlmProviderError);
  });
  it("requires an API key", async () => {
    await expect(generateReply({} as Bindings, "S", "Q")).rejects.toThrow(LlmConfigurationError);
    await expect(embedQuery({} as Bindings, "q")).rejects.toThrow(LlmConfigurationError);
  });
});

describe("埋め込み生成", () => {
  it("プライベート埋め込み API は専用エンドポイント・モデル・認証を使う", async () => {
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      expect(url).toBe("http://embedding.test:8000/v1/embeddings");
      expect(JSON.parse(String(init.body))).toEqual({
        model: "gte-qwen2-1.5b-q4km-124fbdad", input: "hello", dimensions: 1536, encoding_format: "float",
      });
      expect(new Headers(init.headers).get("authorization")).toBe("Bearer local-inference");
      return jsonResponse({ data: [{ index: 0, embedding: testEmbedding(0.5, -0.25, 0) }] });
    });
    await expect(embedQuery({
      ...ENV, EMBEDDING_MODEL: "gte-qwen2-1.5b-q4km-124fbdad",
      EMBEDDING_BASE_URL: "http://embedding.test:8000/v1/", EMBEDDING_API_KEY: "local-inference",
    }, "hello")).resolves.toEqual(testEmbedding(0.5, -0.25, 0));
  });

  it("text-embedding-3-small に単一テキストを送り、埋め込みを取得する", async () => {
    let sent: Record<string, unknown> = {};
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      expect(url).toBe("https://openai.test/v1/embeddings");
      sent = JSON.parse(init.body as string);
      return jsonResponse({ data: [{ index: 0, embedding: testEmbedding(0.5, -0.25, 0) }] });
    });

    const v = await embedQuery(ENV, "hello");
    expect(sent).toEqual({
      model: "text-embedding-3-small",
      input: "hello",
      encoding_format: "float",
      dimensions: 1536,
    });
    expect(v).toEqual(testEmbedding(0.5, -0.25, 0));
  });

  it("空レスポンスはプロバイダエラー", async () => {
    vi.stubGlobal("fetch", async () => jsonResponse({ data: [] }));
    await expect(embedQuery(ENV, "hello")).rejects.toThrow(LlmProviderError);
  });
});
