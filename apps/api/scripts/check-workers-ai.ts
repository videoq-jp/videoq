/** Unified chat/vision preflight: synthetic evidence, no database writes. */
import { existsSync, readFileSync } from "node:fs";
import { parse } from "dotenv";
import { HumanMessage, ToolMessage } from "@langchain/core/messages";
import { createChatModel } from "../src/lib/chat-model";
import { generateReply, streamReply } from "../src/lib/llm";
import { answerResponseFormat, assertCompletedAnswer, parseModelAnswer } from "../src/lib/structured-answer";
import { AnswerCostLedger } from "../src/lib/answer-cost-ledger";
import type { Bindings } from "../src/types/bindings";

let stage = "configuration";
function setStage(value: string) {
  stage = value;
  console.info(JSON.stringify({ stage }));
}
async function main() {
  const configured = [new URL("../../../.env", import.meta.url), new URL("../.dev.vars", import.meta.url)]
    .filter(existsSync).reduce<Record<string, string>>((values, path) => ({ ...values, ...parse(readFileSync(path)) }), {});
  const env = { ...configured, ...process.env } as Bindings;
  const endpoint = new URL(env.LLM_BASE_URL || "https://invalid.local");
  if (endpoint.origin !== "https://api.cloudflare.com" || !/^\/client\/v4\/accounts\/[a-f0-9]{32}\/ai\/v1\/?$/.test(endpoint.pathname)
    || endpoint.search || endpoint.hash || endpoint.username || endpoint.password) {
    throw new Error("Set LLM_BASE_URL to the Workers AI account /ai/v1 endpoint.");
  }
  if (!env.LLM_MODEL?.startsWith("@cf/")) throw new Error("Set LLM_MODEL to a Cloudflare-hosted model ID.");
  const ledger = new AnswerCostLedger();
  const chat = createChatModel(env, { maxTokens: 4096, timeoutMs: 120_000, costLedger: ledger });
  if (!process.argv.includes("--probe")) {
    console.info(JSON.stringify({ status: "ready", note: "Use --probe to make billed requests using synthetic evidence." }));
    return;
  }
  setStage("answer");
  const system = "日本語で短く答えてください。根拠は『確認コードは青空です』のみです。segments の text と空の sourceIds 配列を返してください。根拠にない質問には分からないと回答してください。";
  const answer = await generateReply(env, system, "確認コードは何ですか？", ledger);
  if (!answer.segments.some(segment => segment.text.includes("青空"))) throw new Error("Evidence was not reflected in the answer.");
  setStage("missing_evidence");
  const absent = await generateReply(env, system, "動画で説明されている温度は何度ですか？", ledger);
  const absentText = absent.segments.map(segment => segment.text).join("");
  if (!/分か|わか|不明|情報|根拠|記載/.test(absentText) || /[0-9０-９]+\s*[℃度]/.test(absentText)) {
    throw new Error("The model did not acknowledge missing evidence.");
  }
  setStage("stream");
  let completed = false;
  let deltas = 0;
  for await (const chunk of streamReply(env, system, "確認コードは何ですか？", undefined, ledger)) {
    if ("answer" in chunk) completed = chunk.answer.segments.some(segment => segment.text.includes("青空"));
    else if (chunk.text) deltas++;
  }
  if (!completed || !deltas) throw new Error("No completed evidence-grounded streamed answer.");
  setStage("tools");
  const messages = [new HumanMessage("Call preflight_evidence once, then answer using its result. Use segments with text and an empty sourceIds array.")];
  const decision = await chat.invoke(messages, {
    tools: [{ type: "function", function: { name: "preflight_evidence", description: "Read synthetic evidence",
      parameters: { type: "object", properties: {}, additionalProperties: false, required: [] }, strict: true } }],
    tool_choice: { type: "function", function: { name: "preflight_evidence" } },
    response_format: answerResponseFormat,
  });
  const calls = decision.tool_calls;
  if (calls?.length !== 1 || calls[0].name !== "preflight_evidence" || !calls[0].id) throw new Error("Expected one evidence tool call.");
  const terminal = await chat.invoke([...messages, decision, new ToolMessage({ tool_call_id: calls[0].id, content: "The confirmation code is 青空." })], { response_format: answerResponseFormat });
  assertCompletedAnswer(terminal);
  const toolAnswer = parseModelAnswer(terminal.text);
  if (!toolAnswer.segments.some(segment => segment.text.includes("青空"))) throw new Error("Tool evidence was not reflected in the answer.");
  setStage("summary");
  const summary = await createChatModel(env, { timeoutMs: 120_000, purpose: "conversation_summary", costLedger: ledger })
    .invoke([new HumanMessage("次の会話を一文で要約してください。確認コードは青空です。")]);
  assertCompletedAnswer(summary);
  if (!summary.text.includes("青空")) throw new Error("Summary omitted the evidence.");
  setStage("usage");
  if (!ledger.calls.length || ledger.calls.some(call => call.status !== "completed" || !call.usage)) throw new Error("Missing completed usage records.");
  console.info(JSON.stringify({ status: "passed", model: env.LLM_MODEL, calls: ledger.calls }));
}
main().catch((error: unknown) => {
  // Provider errors can contain request details: keep credentials and prompts out of logs.
  console.error(JSON.stringify({ status: "failed", stage, failureType: error instanceof Error ? error.name : "unknown", hint: stage === "configuration" ? "Configure LLM_BASE_URL, LLM_API_KEY and LLM_MODEL (see .dev.vars.example)." : "Workers AI preflight failed; check model compatibility and account permissions." }));
  process.exitCode = 1;
});
