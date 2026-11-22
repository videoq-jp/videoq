import { afterEach, describe, expect, it, vi } from "vitest";
import { workersAiFetch, WORKERS_AI_LLM_MODEL } from "../src/lib/workers-ai-transport";
import { AnswerCostLedger } from "../src/lib/answer-cost-ledger";
import { createChatModel } from "../src/lib/chat-model";
import { generateReply, streamReply } from "../src/lib/llm";
import type { Bindings } from "../src/types/bindings";
import { createSceneSearchTool } from "../src/tools/scene-search";
import { answerResponseFormat } from "../src/lib/structured-answer";

const answer = { segments: [{ text: "画像の回答", sourceIds: [] }] };
afterEach(() => vi.unstubAllGlobals());

describe("Workers AI native transport", () => {
  const searchTool = { type: "function" as const, function: { name: "search_scenes", parameters: {
    type: "object", properties: { query: { type: "string" }, video_ids: {
      anyOf: [{ type: "array", items: { type: "integer" } }, { type: "null" }],
    } }, required: ["query", "video_ids"], additionalProperties: false,
  } } };
  const toolCompletion = (args: string, name = "search_scenes") => ({
    id: "native-tool", model: WORKERS_AI_LLM_MODEL, object: "chat.completion", created: 0,
    choices: [{ index: 0, finish_reason: "tool_calls", message: { role: "assistant", content: null,
      tool_calls: [{ id: "call-search", type: "function", function: { name, arguments: args } }],
    } }], usage: { prompt_tokens: 10, completion_tokens: 8, total_tokens: 18 },
  });
  it.each([
    [false, "null"], [true, "null"], [false, "None"], [true, "None"],
  ] as const)("repairs the observed absent selection before LangChain executes search (stream=%s, value=%s)", async (streaming, absent) => {
    const query = "nullとNoneについて SIFT";
    const run = vi.fn(async () => Response.json(toolCompletion(JSON.stringify({ query, video_ids: absent }))));
    const ledger = new AnswerCostLedger();
    const model = createChatModel({ AI: { run }, LLM_MODEL: WORKERS_AI_LLM_MODEL,
      LLM_SEPARATE_TOOL_SCHEMA: "true" } as Bindings, { timeoutMs: 1000, costLedger: ledger });
    const options = { tools: [searchTool], response_format: answerResponseFormat };
    const calls = [];
    if (streaming) {
      for await (const chunk of await model.stream("SIFTとは", options)) calls.push(...(chunk.tool_calls ?? []));
    } else calls.push(...((await model.invoke("SIFTとは", options)).tool_calls ?? []));
    expect(calls).toHaveLength(1);
    const search = vi.fn(async () => []);
    const definition = createSceneSearchTool({ search, close: async () => undefined }, [42]);
    const args = definition.schema.parse(calls[0].args);
    await definition.invoke(args, { signal: new AbortController().signal });
    expect(search).toHaveBeenCalledWith(query, undefined, expect.any(AbortSignal));
    expect(ledger.calls).toMatchObject([{ status: "completed", usage: { total_tokens: 18 } }]);
  });
  it.each([
    ['{"query":"null","video_ids":null}', "search_scenes"],
    ['{"query":"null","video_ids":[42]}', "search_scenes"],
    ['{"query":"null","video_ids":"NULL"}', "search_scenes"],
    ['{"query":"None","video_ids":"none"}', "search_scenes"],
    ['{"query":"None","video_ids":" None "}', "search_scenes"],
    ['{"query":"null","video_ids":"[]"}', "search_scenes"],
    ['{"query":"null","video_ids":"null"}', "other_tool"],
    ['{"query":"None","video_ids":"None"}', "other_tool"],
    ['not JSON', "search_scenes"],
  ])("preserves unrelated or invalid arguments: %s (%s)", async (args, name) => {
    const completion = toolCompletion(args, name);
    const run = vi.fn(async () => Response.json(completion));
    const response = await workersAiFetch({ run })("https://workers-ai.internal/v1/chat/completions", {
      method: "POST", body: JSON.stringify({ model: WORKERS_AI_LLM_MODEL, messages: [], tools: [searchTool] }),
    });
    expect(await response.json()).toEqual(completion);
  });
  it.each([false, true])("passes provider errors and streaming bodies through without reading (stream=%s)", async streaming => {
    const response = new Response(streaming ? "data: [DONE]\n\n" : '{"error":"unavailable"}', {
      status: streaming ? 200 : 503,
    });
    const run = vi.fn(async () => response);
    expect(await workersAiFetch({ run })("https://workers-ai.internal/v1/chat/completions", {
      method: "POST", body: JSON.stringify({ model: WORKERS_AI_LLM_MODEL, messages: [], tools: [searchTool], stream: streaming }),
    })).toBe(response);
    expect(response.bodyUsed).toBe(false);
  });
  it("shares the binding between answers and summaries without external credentials", async () => {
    const external = vi.fn();
    vi.stubGlobal("fetch", external);
    const run = vi.fn(async (_model: string, body: Record<string, unknown>, _options: Record<string, unknown>) => {
      const completion = { id: "native", model: WORKERS_AI_LLM_MODEL, object: "chat.completion", created: 0,
        choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: JSON.stringify(answer) } }],
        usage: { prompt_tokens: 10, completion_tokens: 8, total_tokens: 18 } };
      if (!body.stream) return Response.json(completion);
      return new Response(`data: ${JSON.stringify({ id: "native", model: WORKERS_AI_LLM_MODEL,
        object: "chat.completion.chunk", created: 0, choices: [{ index: 0,
          delta: { role: "assistant", content: JSON.stringify(answer) }, finish_reason: "stop" }], usage: { prompt_tokens: 0, completion_tokens: 1, total_tokens: 1 } })}\n\ndata: ${JSON.stringify({ response: "", usage: completion.usage })}\n\ndata: [DONE]\n\n`,
      { headers: { "content-type": "text/event-stream" } });
    });
    const env = { AI: { run }, LLM_MODEL: WORKERS_AI_LLM_MODEL, LLM_MAX_TOKENS: "4096" } as Bindings;
    const ledger = new AnswerCostLedger();
    expect(await generateReply(env, "S", "Q", ledger)).toEqual(answer);
    const chunks = [];
    for await (const chunk of streamReply(env, "S", "Q", undefined, ledger)) chunks.push(chunk);
    expect(chunks.at(-1)).toEqual({ answer });
    await createChatModel(env, { purpose: "conversation_summary", timeoutMs: 1000, costLedger: ledger }).invoke("Summarize");
    expect(run).toHaveBeenCalledTimes(3);
    expect(ledger.calls).toHaveLength(3);
    for (const call of ledger.calls) expect(call).toMatchObject({ status: "completed", usage: { prompt_tokens: 10, completion_tokens: 8, total_tokens: 18 } });
    expect(external).not.toHaveBeenCalled();
    for (const [model, body, options] of run.mock.calls) {
      expect(model).toBe(WORKERS_AI_LLM_MODEL);
      expect(body.chat_template_kwargs).toEqual({ enable_thinking: false });
      expect(options.returnRawResponse).toBe(true);
    }
  });
  it("forwards cancellation to the binding and returns its raw response unchanged", async () => {
    const response = Response.json({ choices: [] });
    const run = vi.fn(async (_model: string, _body: unknown, _options: { signal: AbortSignal }) => response);
    const controller = new AbortController();
    expect(await workersAiFetch({ run })("https://workers-ai.internal/v1/chat/completions", {
      method: "POST", signal: controller.signal,
      body: JSON.stringify({ model: WORKERS_AI_LLM_MODEL, messages: [{ role: "user", content: "Q" }] }),
    })).toBe(response);
    const options = run.mock.calls[0][2];
    controller.abort();
    expect(options.signal.aborted).toBe(true);
  });
  it("rejects another operation or model before calling inference", async () => {
    const run = vi.fn();
    const fetch = workersAiFetch({ run });
    expect((await fetch("https://workers-ai.internal/v1/embeddings", { method: "POST" })).status).toBe(400);
    expect((await fetch("https://workers-ai.internal/v1/chat/completions", { method: "POST",
      body: JSON.stringify({ model: "gpt", messages: [] }) })).status).toBe(400);
    expect(run).not.toHaveBeenCalled();
  });
});
