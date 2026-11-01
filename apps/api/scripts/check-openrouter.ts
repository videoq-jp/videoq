/** Paid, opt-in model preflight. No DB writes or deployment changes. */
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath, URL } from "node:url";
import { promisify } from "node:util";
import { resolve } from "node:path";
import { parse } from "dotenv";
import { HumanMessage, ToolMessage } from "@langchain/core/messages";
import { createChatModel } from "../src/lib/chat-model";
import { embedQuery } from "../src/lib/embeddings";
import { generateReply, streamReply } from "../src/lib/llm";
import { answerResponseFormat, assertCompletedAnswer, parseModelAnswer } from "../src/lib/structured-answer";
import type { Bindings } from "../src/types/bindings";

const root = new URL("../../../", import.meta.url);
const exec = promisify(execFile);
let stage = "configuration";

async function main() {
  const configured = [new URL(".env", root), new URL("../.dev.vars", import.meta.url)]
    .filter(existsSync).reduce<Record<string, string>>((values, path) => ({ ...values, ...parse(readFileSync(path)) }), {});
  const settings = { ...configured, ...process.env };
  const key = settings.OPENROUTER_API_KEY;
  const policy = settings.OPENROUTER_FEDERATION_POLICY_ID;
  const args = process.argv.slice(2);
  const audioArg = args.find(arg => !arg.startsWith("--"));
  const python = process.env.VIDEOQ_TEST_PYTHON || "python3";
  if (!key && !policy) throw new Error("Set OPENROUTER_FEDERATION_POLICY_ID or a development OPENROUTER_API_KEY.");
  if (policy && (!settings.AWS_REGION || !settings.AWS_ACCESS_KEY_ID || !settings.AWS_SECRET_ACCESS_KEY)) {
    throw new Error("API federation requires AWS_REGION and AWS workload credentials.");
  }
  if (!audioArg || !existsSync(audioArg)) throw new Error("Provide a short, non-sensitive speech file path.");
  const audio = resolve(audioArg);
  const imagePath = new URL("apps/web/public/apple-touch-icon.png", root);
  const image = readFileSync(imagePath).toString("base64");
  await exec(python, ["-c", "import openai, httpx, numpy, psycopg, boto3, cryptography"], { timeout: 15_000 });
  if (!args.includes("--probe")) {
    console.info(JSON.stringify({ status: "ready", note: "Add --probe to upload the fixture and make paid model calls." }));
    return;
  }
  const env = { ...settings, LLM_API_KEY: undefined, EMBEDDING_API_KEY: undefined, LLM_BASE_URL: undefined, EMBEDDING_BASE_URL: undefined, OPENROUTER_API_KEY: key, OPENAI_BASE_URL: "https://openrouter.ai/api/v1",
    LLM_MODEL: "openai/gpt-6-luna", EMBEDDING_MODEL: "openai/text-embedding-3-small" } as Bindings;
  stage = "answer";
  const system = "Return the requested answer in segments with text and an empty sourceIds array. Be brief.";
  await generateReply(env, system, "Reply with the word Ready.");
  stage = "stream";
  let completed = false;
  let deltas = 0;
  for await (const chunk of streamReply(env, system, "Reply with the words Stream ready.")) {
    if ("answer" in chunk) completed = true;
    else if (chunk.text) deltas++;
  }
  if (!completed || !deltas) throw new Error("No completed streamed answer.");
  stage = "tools";
  const chat = createChatModel(env, { maxTokens: 1024, timeoutMs: 120_000 });
  const messages = [new HumanMessage("Call preflight_evidence once, then answer using its result. Use segments with text and an empty sourceIds array.")];
  const decision = await chat.invoke(messages, {
    tools: [{ type: "function", function: { name: "preflight_evidence", description: "Read synthetic preflight evidence",
      parameters: { type: "object", properties: {}, additionalProperties: false, required: [] }, strict: true } }],
    tool_choice: { type: "function", function: { name: "preflight_evidence" } },
    response_format: answerResponseFormat,
  });
  const calls = decision.tool_calls;
  if (calls?.length !== 1 || calls[0].name !== "preflight_evidence" || !calls[0].id) throw new Error("Expected one evidence tool call.");
  const answer = await chat.invoke([...messages, decision, new ToolMessage({ tool_call_id: calls[0].id, content: "The preflight is ready." })], { response_format: answerResponseFormat });
  assertCompletedAnswer(answer);
  parseModelAnswer(answer.text);
  stage = "images";
  const visual = await chat.invoke([new HumanMessage({ content: [
    { type: "text", text: "Briefly describe the visible icon. Use segments with text and an empty sourceIds array." },
    { type: "image_url", image_url: { url: `data:image/png;base64,${image}`, detail: "low" } },
  ] })], { response_format: answerResponseFormat });
  assertCompletedAnswer(visual);
  parseModelAnswer(visual.text);
  stage = "query_embedding";
  await embedQuery(env, "VideoQ OpenRouter preflight");
  stage = "worker_whisper_and_indexing";
  const worker = fileURLToPath(new URL("apps/worker/", root));
  const { stdout } = await exec(python, [fileURLToPath(new URL("apps/worker/scripts/check_openrouter.py", root)), audio], {
    cwd: worker, env: { ...settings, PYTHONPATH: worker }, timeout: 420_000, maxBuffer: 64 * 1024,
  });
  const result: unknown = JSON.parse(stdout);
  if (!result || typeof result !== "object" || !("dimensions" in result) || !("segments" in result) || typeof result.segments !== "number") throw new Error("Invalid worker preflight response.");
  if (result.dimensions !== 1536 || result.segments < 1) throw new Error("Worker preflight did not meet the contract.");
  console.info(JSON.stringify({ status: "passed", scope: "model_preflight", answer: true, streaming: true,
    tools: true, images: true, queryDimensions: 1536, worker: result }));
}

main().catch(error => {
  // Do not print SDK exceptions, child stderr, prompts, media, or credentials.
  console.error(JSON.stringify({ status: "failed", stage,
    ...(stage === "configuration" ? { message: "Check federation settings or development key, speech path and Python dependencies. No model calls were made." }
      : { errorType: error instanceof Error ? error.name : "Error" }) }));
  process.exitCode = 1;
});
