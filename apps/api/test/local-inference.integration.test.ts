import { describe, expect, it, vi } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { HumanMessage } from "@langchain/core/messages";
import { generateReply, streamReply } from "../src/lib/llm";
import { embedQuery } from "../src/lib/embeddings";
import { embeddingDimensions, resolveEmbeddingConfig } from "../src/lib/embedding-contract";
import { createChatModel } from "../src/lib/chat-model";
import { streamRag } from "../src/lib/rag";
import { openSceneSearch } from "../src/repositories/vector-repository";
import type { Bindings } from "../src/types/bindings";

// Retrieval is a fixed, nonsensitive fixture; inference is real. This checks
// tools + response_format together through the production agent, without DB IO.
vi.mock("../src/repositories/vector-repository", () => ({ openSceneSearch: vi.fn(async () => ({
  search: async () => [{ videoId: 42, videoTitle: "Backup policy", startTime: "00:00:01,000",
    endTime: "00:00:08,000", content: "Database backups are retained for seven days." }],
  close: async () => undefined,
})) }));

// Explicit opt-in. Unit CI never downloads models or calls hosted inference.
const chatBase = process.env.LOCAL_AI_TEST_CHAT_BASE_URL;
const embeddingBase = process.env.LOCAL_AI_TEST_EMBEDDING_BASE_URL;
const env = {
  OPENAI_API_KEY: process.env.LOCAL_AI_TEST_API_KEY || "local-inference", OPENAI_BASE_URL: chatBase,
  LLM_MODEL: process.env.LOCAL_AI_TEST_MODEL || "videoq-chat", LLM_REASONING_EFFORT: process.env.LOCAL_AI_TEST_REASONING_EFFORT || "none",
  LLM_PRESERVE_TOOL_REASONING: process.env.LOCAL_AI_TEST_PRESERVE_TOOL_REASONING || "false",
  EMBEDDING_PROFILE: process.env.LOCAL_AI_TEST_EMBEDDING_PROFILE || "openai",
  LLM_SEPARATE_TOOL_SCHEMA: process.env.LOCAL_AI_TEST_SEPARATE_TOOL_SCHEMA || "true",
  EMBEDDING_BASE_URL: embeddingBase, EMBEDDING_API_KEY: process.env.LOCAL_AI_TEST_EMBEDDING_API_KEY, EMBEDDING_MODEL: process.env.LOCAL_AI_TEST_EMBEDDING_MODEL || "gte-qwen2-1.5b-q4km-124fbdad",
  VIDEO_VISUAL_ENABLED: "false", LLM_REQUEST_TIMEOUT_MS: "600000", LLM_STREAM_TIMEOUT_MS: "600000",
} as Bindings;
if (chatBase && !embeddingBase) throw new Error("Explicit LOCAL_AI_TEST_EMBEDDING_BASE_URL is required; hosted defaults are forbidden");
const withModels = chatBase ? describe : describe.skip;

withModels("real local inference compatibility", () => {
  const system = 'Source ID 1: Database backups are retained for seven days. Answer using only this source; cite numeric source ID 1 in sourceIds.';
  const question = "How many days are database backups retained?";
  it("produces and validates the application's cited structured answer", async () => {
    const answer = await generateReply(env, system, question);
    expect(answer.segments.map(s => s.text).join(" ")).toMatch(/seven|7/i);
    expect(answer.segments.flatMap(s => s.sourceIds)).toContain(1);
  }, 180_000);
  it("streams the same structured contract through the application SSE parser", async () => {
    const events = [];
    for await (const event of streamReply(env, system, question)) events.push(event);
    expect(events.some(event => "text" in event)).toBe(true);
    expect(events.at(-1)).toHaveProperty("answer");
  }, 300_000);
  it("calls tools using the application's chat adapter", async () => {
    const model = createChatModel(env, { maxTokens: 1024, timeoutMs: 120_000 }).bindTools([{
      type: "function", function: { name: "lookup_video", description: "Find a video by name.",
        parameters: { type: "object", properties: { name: { type: "string" } }, required: ["name"], additionalProperties: false } },
    }]);
    const answer = await model.invoke([new HumanMessage('Call lookup_video with name "Amber Lantern". Use the tool now.')]);
    expect(answer.tool_calls).toContainEqual(expect.objectContaining({ name: "lookup_video", args: { name: "Amber Lantern" } }));
  }, 180_000);
  it("generates the selected profile's query vector used by pgvector", async () => {
    const vector = await embedQuery(env, "database backup retention");
    expect(vector).toHaveLength(embeddingDimensions(resolveEmbeddingConfig(env)));
    expect(vector.every(Number.isFinite)).toBe(true);
    expect(vector.some(value => value !== 0)).toBe(true);
  }, 120_000);
  it.skipIf(!process.env.LOCAL_AI_TEST_WORKER_PYTHON)("uses identical query and indexing embedding spaces across TypeScript and Python", async () => {
    const text = "database backups are retained for seven days";
    const query = await embedQuery(env, text);
    const { stdout } = await promisify(execFile)(process.env.LOCAL_AI_TEST_WORKER_PYTHON!, ["-c",
      "import json; from worker_python.pipeline.embeddings import embed_texts; print(json.dumps(embed_texts(['database backups are retained for seven days', 'unrelated cooking lesson'])))"], {
      cwd: fileURLToPath(new URL("../../worker", import.meta.url)), timeout: 120_000, maxBuffer: 1024 * 1024,
      env: { PATH: process.env.PATH, OPENAI_API_KEY: env.OPENAI_API_KEY,
        OPENAI_BASE_URL: "http://chat-must-not-receive-embeddings.invalid/v1", EMBEDDING_BASE_URL: env.EMBEDDING_BASE_URL,
        EMBEDDING_API_KEY: env.EMBEDDING_API_KEY,
        EMBEDDING_MODEL: env.EMBEDDING_MODEL, EMBEDDING_PROFILE: env.EMBEDDING_PROFILE },
    });
    const batch = JSON.parse(stdout) as number[][];
    expect(batch).toHaveLength(2);
    expect(batch.every(vector => vector.length === embeddingDimensions(resolveEmbeddingConfig(env)) && vector.every(Number.isFinite))).toBe(true);
    const cosine = (a: number[], b: number[]) => a.reduce((sum, value, index) => sum + value * b[index], 0)
      / Math.sqrt(a.reduce((sum, value) => sum + value ** 2, 0) * b.reduce((sum, value) => sum + value ** 2, 0));
    // Asymmetric query/document prompts intentionally produce distinct vectors.
    if (env.EMBEDDING_PROFILE !== "embeddinggemma2") expect(cosine(query, batch[0])).toBeGreaterThan(0.999);
    expect(cosine(query, batch[0])).toBeGreaterThan(cosine(query, batch[1]));
  }, 150_000);
  it.each([
    { query: "バックアップは何日間保存されますか？", document: "Database backups are retained for seven days." },
    { query: "How long are database backups kept?", document: "データベースのバックアップは7日間保存します。" },
  ])("retrieves across Japanese and English: $query", async ({ query: question, document }) => {
    if (!process.env.LOCAL_AI_TEST_WORKER_PYTHON) return;
    const query = await embedQuery(env, question);
    const { stdout } = await promisify(execFile)(process.env.LOCAL_AI_TEST_WORKER_PYTHON, ["-c",
      "import json,sys; from worker_python.pipeline.embeddings import embed_texts; print(json.dumps(embed_texts(json.loads(sys.argv[1]))))",
      JSON.stringify([document, "This cooking lesson explains how to bake a chocolate cake."])], {
      cwd: fileURLToPath(new URL("../../worker", import.meta.url)), timeout: 120_000,
      env: { PATH: process.env.PATH, OPENAI_API_KEY: env.OPENAI_API_KEY,
        OPENAI_BASE_URL: "http://chat-must-not-receive-embeddings.invalid/v1", EMBEDDING_BASE_URL: env.EMBEDDING_BASE_URL,
        EMBEDDING_API_KEY: env.EMBEDDING_API_KEY, EMBEDDING_MODEL: env.EMBEDDING_MODEL, EMBEDDING_PROFILE: env.EMBEDDING_PROFILE },
    });
    const vectors = JSON.parse(stdout) as number[][];
    const score = (v: number[]) => v.reduce((sum, x, i) => sum + x * query[i], 0)
      / Math.sqrt(v.reduce((sum, x) => sum + x * x, 0) * query.reduce((sum, x) => sum + x * x, 0));
    expect(score(vectors[0])).toBeGreaterThan(score(vectors[1]));
  }, 150_000);
  it("searches and emits timestamp citations through the production streaming RAG agent", async () => {
    let final;
    for await (const event of streamRag(env, { ownerUserId: "local-acceptance", videoIds: [42], locale: "en",
      messages: [{ role: "user", content: "According to the course subtitles, how many days are database backups retained? Search the subtitles to find the policy." }],
    })) {
      if ("final" in event) final = event.final;
    }
    expect(openSceneSearch).toHaveBeenCalled();
    expect(final?.answer.segments.map(segment => segment.text).join(" ")).toMatch(/seven|7/i);
    expect(final?.answer.sources).toContainEqual(expect.objectContaining({ video_id: 42, start_time: "00:00:01,000" }));
    expect(final?.answer.segments.flatMap(segment => segment.sourceIds)).toContain(1);
  }, 600_000);
});
