import { readFileSync } from "node:fs";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { chatAnswerText } from "@videoq/trpc/chat";
import { WORKERS_AI_LLM_MODEL } from "../src/lib/workers-ai-transport";
import { AnswerCostLedger } from "../src/lib/answer-cost-ledger";
import type { Bindings } from "../src/types/bindings";

// Only media/database fixtures are substituted. Agent, MCP tools, vision SDK,
// citations, streaming, and both model calls are the production implementations.
// Explicit opt-in: this makes billed requests and uploads only synthetic JPEGs.
const enabled = process.env.WORKERS_AI_VISUAL_LIVE === "1";
let nativeAi: Ai | undefined;
let dispose: (() => Promise<void>) | undefined;
beforeAll(async () => {
  if (!enabled || process.env.WORKERS_AI_NATIVE_LIVE !== "1") return;
  const { getPlatformProxy } = await import("wrangler");
  const proxy = await getPlatformProxy<{ AI: Ai }>({
    configPath: process.env.WORKERS_AI_NATIVE_CONFIG,
    remoteBindings: true, persist: false,
  });
  // Miniflare's Node RPC bridge cannot serialize AbortSignal. Production runs
  // inside workerd; its signal forwarding is covered by transport unit tests.
  nativeAi = new Proxy(proxy.env.AI, {
    get(target, name, receiver) {
      if (name !== "run") return Reflect.get(target, name, receiver);
      return async (model: typeof WORKERS_AI_LLM_MODEL, inputs: AiModels[typeof WORKERS_AI_LLM_MODEL]["inputs"]) => {
        const response = await target.run(model, inputs, { returnRawResponse: true });
        // Consume the finite fixture response before crossing Node's RPC bridge:
        // SDK cancellation at [DONE] otherwise races Miniflare's stream writer.
        // The production transport itself never buffers; workerd tests cover it.
        return new Response(await response.arrayBuffer(), { status: response.status, headers: response.headers });
      };
    },
  });
  dispose = proxy.dispose;
}, 60_000);
afterAll(async () => { await dispose?.(); });
vi.mock("../src/repositories/vector-repository", () => ({ openSceneSearch: async () => ({
  search: async () => [], close: async () => undefined,
}) }));
vi.mock("../src/repositories/course-repository", () => ({ getCourseInfo: async () => null }));
vi.mock("../src/repositories/video-evidence-repository", () => ({ getVideoEvidence: async () => ({
  id: 42, title: "Synthetic shapes", fileKey: "fixture/shapes.mp4", sourceType: "uploaded",
  transcript: "", transcriptTooLarge: false,
}) }));
vi.mock("../src/integrations/media", () => ({ readMediaBytes: async (_env: Bindings, key: string) => {
  if (!key.endsWith(".frames-v1.json")) return null;
  return new TextEncoder().encode(JSON.stringify({
    version: 1, video_id: 42, duration_seconds: 10, sampling_interval_seconds: 5,
    frames: ["red-circle", "blue-square"].map((name, i) => ({
      timestamp_seconds: i * 5,
      jpeg_base64: readFileSync(new URL(`./fixtures/workers-ai/${name}.jpg`, import.meta.url)).toString("base64"),
    })),
  }));
} }));
const { runRag, streamRag } = await import("../src/lib/rag");
afterEach(() => vi.clearAllMocks());

describe.skipIf(!enabled)("Workers AI real Gemma visual tool round trip", () => {
  it.each([false, true])("inspects two real images and cites their observations (stream=%s)", async streaming => {
    const env = { ...process.env, ...(nativeAi ? { AI: nativeAi, LLM_BASE_URL: undefined, LLM_API_KEY: undefined } : {}) } as Bindings;
    if (!nativeAi) expect(env.LLM_BASE_URL).toMatch(/^https:\/\/api\.cloudflare\.com\/client\/v4\/accounts\/[a-f0-9]{32}\/ai\/v1\/?$/);
    expect(env.LLM_MODEL).toBe("@cf/google/gemma-4-26b-a4b-it");
    const ledger = new AnswerCostLedger();
    const params = { ownerUserId: "fixture-owner", videoIds: [42], locale: "ja",
      messages: [{ role: "user", content: "動画ID 42の0秒から10秒の画像をinspect_clipで確認してください。最初と次のフレームそれぞれに何色のどんな形があるか、日本語で順番に答え、画像の出典を付けてください。字幕からは分かりません。" }],
      costLedger: ledger };
    let result;
    let text = "";
    if (streaming) {
      for await (const chunk of streamRag(env, params)) {
        if ("part" in chunk && chunk.part.type === "text") text += chunk.part.text;
        if ("final" in chunk) result = chunk.final;
      }
    } else result = await runRag(env, params);
    expect(result).toBeDefined();
    const answer = chatAnswerText(result.answer);
    expect(answer).toMatch(/赤/);
    expect(answer).toMatch(/円|丸/);
    expect(answer).toMatch(/青/);
    expect(answer).toMatch(/四角|正方形/);
    if (streaming) expect(text).toBe(answer);
    const visualSources = result.answer.sources.filter(source => source.evidence_type === "visual");
    expect(visualSources.length).toBeGreaterThanOrEqual(2);
    expect(visualSources.every(source => source.video_id === 42)).toBe(true);
    const cited = result.answer.segments.flatMap(segment => segment.sourceIds);
    expect(visualSources.some(source => cited.includes(source.id))).toBe(true);
    for (const kind of ["answer_model", "visual_inspection"] as const) {
      const calls = ledger.calls.filter(call => call.kind === kind);
      expect(calls.length).toBeGreaterThan(0);
      expect(calls.every(call => call.model === env.LLM_MODEL && call.status === "completed" && call.usage)).toBe(true);
    }
  }, 300_000);
});
