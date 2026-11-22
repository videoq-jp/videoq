import { afterEach, describe, expect, it, vi } from "vitest";
import { workersAiFetch, WORKERS_AI_LLM_MODEL } from "../src/lib/workers-ai-transport";
import { AnswerCostLedger } from "../src/lib/answer-cost-ledger";
import { createChatModel } from "../src/lib/chat-model";
import { generateReply, streamReply } from "../src/lib/llm";
import type { Bindings } from "../src/types/bindings";

const answer = { segments: [{ text: "画像の回答", sourceIds: [] }] };
afterEach(() => vi.unstubAllGlobals());

describe("Workers AI native transport", () => {
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
