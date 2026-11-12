/** Real provider checks through the production API and worker embedding clients. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { HumanMessage } from "@langchain/core/messages";
import { embedQuery } from "../../apps/api/src/lib/embeddings";
import { generateReply, streamReply } from "../../apps/api/src/lib/llm";
import { createChatModel } from "../../apps/api/src/lib/chat-model";
import type { Bindings } from "../../apps/api/src/types/bindings";

async function main() {
  const mode = process.argv[2];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (...args) => {
    const response = await originalFetch(...args);
    if (!response.ok) console.error("Public fixture request rejected:", response.status, await response.clone().text());
    return response;
  };
  const env = {
    OPENAI_API_KEY: "local-inference", OPENAI_BASE_URL: "http://127.0.0.1:8000/v1",
    LLM_MODEL: "videoq-chat", LLM_REASONING_EFFORT: "low", LLM_PRESERVE_TOOL_REASONING: "true",
    LLM_SEPARATE_TOOL_SCHEMA: "true", LLM_REQUEST_TIMEOUT_MS: "180000", LLM_STREAM_TIMEOUT_MS: "180000",
    EMBEDDING_PROFILE: "embeddinggemma2", EMBEDDING_BASE_URL: "http://127.0.0.1:8000/v1",
    EMBEDDING_MODEL: "embeddinggemma-2-f9972ac", VIDEO_VISUAL_ENABLED: "false",
  } as Bindings;
  if (mode === "embedding") {
    const cases = [
      {query: "バックアップは何日間保存されますか？", document: "Database backups are retained for seven days."},
      {query: "How long are database backups retained?", document: "データベースのバックアップは7日間保存します。"},
    ];
    const checks = [];
    for (const item of cases) {
      const query = await embedQuery(env, item.query);
      const output = execFileSync("python3", ["-c", "import json,sys; from worker_python.pipeline.embeddings import embed_texts; print(json.dumps(embed_texts(json.loads(sys.argv[1]))))",
        JSON.stringify([item.document, "This cooking lesson explains how to bake a chocolate cake."])], {
        env: {...process.env, OPENAI_API_KEY: "local-inference", EMBEDDING_PROFILE: env.EMBEDDING_PROFILE,
          EMBEDDING_BASE_URL: env.EMBEDDING_BASE_URL, EMBEDDING_MODEL: env.EMBEDDING_MODEL,
          PYTHONPATH: "/tmp/probe-worker:/opt/videoq-audio"}, timeout: 120000, maxBuffer: 1024 * 1024,
      });
      const documents = JSON.parse(output.toString()) as number[][];
      assert.equal(query.length, 768);
      assert.equal(documents.length, 2);
      assert.ok(documents.every(vector => vector.length === 768 && vector.every(Number.isFinite)));
      const norm = (vector: number[]) => Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
      assert.ok(Math.abs(norm(query) - 1) < 0.001);
      const similarity = documents.map(vector => vector.reduce((sum, value, index) => sum + value * query[index], 0) / norm(vector) / norm(query));
      assert.ok(similarity[0] > similarity[1], "Cross-language query must retrieve the relevant indexed document");
      checks.push({query: item.query, dimensions: query.length, norm: norm(query), similarity});
    }
    console.log(JSON.stringify({status: "passed", mode, checks}));
  } else if (mode === "chat") {
    const system = "Source ID 1: Database backups are retained for seven days. Answer using only this source; cite numeric source ID 1 in sourceIds.";
    const question = "How many days are database backups retained?";
    const answer = await generateReply(env, system, question);
    assert.match(answer.segments.map(segment => segment.text).join(" "), /seven|7/i);
    assert.ok(answer.segments.flatMap(segment => segment.sourceIds).includes(1));
    const events = [];
    for await (const event of streamReply(env, system, question)) events.push(event);
    assert.ok(events.some(event => "text" in event));
    assert.ok(events.at(-1) && "answer" in events.at(-1)!);
    const model = createChatModel(env, {maxTokens: 1024, timeoutMs: 120000}).bindTools([{
      type: "function", function: {name: "lookup_video", description: "Find a video by name.", parameters: {
        type: "object", properties: {name: {type: "string"}}, required: ["name"], additionalProperties: false,
      }},
    }]);
    const tool = await model.invoke([new HumanMessage('Call lookup_video with name "Amber Lantern". Use the tool now.')]);
    assert.ok(tool.tool_calls?.some(call => call.name === "lookup_video" && call.args.name === "Amber Lantern"));
    console.log(JSON.stringify({status: "passed", mode, answer, streamEvents: events.length, toolCalls: tool.tool_calls}));
  } else throw new Error("Expected embedding or chat");
}
main().catch(error => {console.error(error); process.exitCode = 1;});
