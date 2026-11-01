import { afterEach, describe, expect, it, vi } from "vitest";
import { createChatModel } from "../src/lib/chat-model";
import { AnswerCostLedger } from "../src/lib/answer-cost-ledger";
import { assertCompletedAnswer } from "../src/lib/structured-answer";
import type { Bindings } from "../src/types/bindings";

afterEach(() => vi.unstubAllGlobals());

describe("library-owned model stream assembly", () => {
  it("treats repeated terminal metadata and usage as snapshots", async () => {
    const usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, cost: 0.001 };
    const terminal = { id: "answer", model: "vendor/model", usage,
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }] };
    vi.stubGlobal("fetch", async () => new Response([
      { id: "answer", choices: [{ index: 0, delta: { role: "assistant", content: "Answer" }, finish_reason: null }] },
      terminal, terminal, { choices: [], usage },
    ].map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n", {
      headers: { "content-type": "text/event-stream" },
    }));
    const costLedger = new AnswerCostLedger();
    const model = createChatModel({ OPENAI_API_KEY: "test", OPENAI_BASE_URL: "https://openai.test/v1", LLM_MODEL: "vendor/model" } as Bindings,
      { maxTokens: 1024, timeoutMs: 1000, costLedger });
    const stream = model.streamEvents("Question");
    const text = [];
    for await (const delta of stream.text) text.push(delta);
    const message = await stream;
    expect(text).toEqual(["Answer"]);
    expect(() => assertCompletedAnswer(message)).not.toThrow();
    expect(message.response_metadata).toMatchObject({ model_name: "vendor/model", finish_reason: "stop" });
    expect(message.usage_metadata).toMatchObject({ input_tokens: 10, output_tokens: 5, total_tokens: 15 });
    expect(costLedger.calls).toMatchObject([{ status: "completed", usage }]);
  });
});
