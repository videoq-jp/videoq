import { URL } from "node:url";
/** Opt-in real planner + vision evaluation against externally supplied v1 caches.
 * VIDEOQ_HIGHLIGHT_EVAL=1 VIDEOQ_HIGHLIGHT_FIXTURE=/path/to/fixture npm run test:unit -- test/highlight-selection.live.test.ts
 * Fixture: metadata.json {id,title,transcript}, coarse.json, focus.bin. Never commit private media.
 * Passing checks execution/budgets only; review the saved answer and observations against the video.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "dotenv";
import { beforeAll, expect, it, vi } from "vitest";
import { streamRag } from "../src/lib/rag";
import { chatAnswerText, type ChatToolProgressEvent } from "@videoq/trpc/chat";
import type { Bindings } from "../src/types/bindings";

const fixture = vi.hoisted(() => ({
  id: 1, title: "", transcript: "", coarse: new Uint8Array(), dense: new Uint8Array(),
}));
vi.mock("../src/integrations/media", () => ({
  readMediaBytes: async () => fixture.coarse,
  readMediaRange: async (_env: Bindings, _key: string, offset: number, length: number) => ({
    bytes: fixture.dense.slice(offset, offset + length), etag: '"fixture"', size: fixture.dense.length,
  }),
}));
vi.mock("../src/repositories/vector-repository", async () => {
  const { iterSrtCues } = await import("@videoq/trpc/transcript");
  return { openSceneSearch: async () => ({
    search: async () => [...iterSrtCues(fixture.transcript)].flatMap(cue => cue ? [{
      videoId: fixture.id, videoTitle: fixture.title, startTime: cue.startTime, endTime: cue.endTime, content: cue.text,
    }] : []),
    close: async () => undefined,
  }) };
});
vi.mock("../src/repositories/video-evidence-repository", () => ({ getVideoEvidence: async () => ({
  id: fixture.id, title: fixture.title, transcript: fixture.transcript,
  sourceType: "uploaded", fileKey: "fixture.mp4", transcriptTooLarge: false,
}) }));
vi.mock("../src/repositories/course-repository", () => ({ getCourseInfo: async () => ({
  name: fixture.title, description: "", video_count: 1,
  videos: [{ id: fixture.id, title: fixture.title, description: "", order: 0, status: "completed" }],
}) }));

const enabled = process.env.VIDEOQ_HIGHLIGHT_EVAL === "1";
let env: Bindings;
let output: string;
beforeAll(() => {
  if (!enabled) return;
  const root = process.env.VIDEOQ_HIGHLIGHT_FIXTURE;
  if (!root) throw new Error("VIDEOQ_HIGHLIGHT_FIXTURE is required");
  Object.assign(fixture, JSON.parse(readFileSync(join(root, "metadata.json"), "utf8")), {
    coarse: new Uint8Array(readFileSync(join(root, "coarse.json"))),
    dense: new Uint8Array(readFileSync(join(root, "focus.bin"))),
  });
  const varsPath = new URL("../.dev.vars", import.meta.url);
  const configured = existsSync(varsPath) ? parse(readFileSync(varsPath)) : {};
  env = Object.fromEntries(["OPENROUTER_FEDERATION_POLICY_ID", "OPENROUTER_FEDERATION_AUDIENCE", "AWS_REGION", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "OPENROUTER_API_KEY", "OPENAI_API_KEY", "OPENAI_BASE_URL", "LLM_API_KEY", "LLM_BASE_URL", "LLM_MODEL"].map(key => [key, process.env[key] ?? configured[key]])) as unknown as Bindings;
  if (!env.OPENROUTER_FEDERATION_POLICY_ID && !env.LLM_API_KEY && !env.OPENROUTER_API_KEY && !env.OPENAI_API_KEY) throw new Error("OPENROUTER_API_KEY, LLM_API_KEY or OPENAI_API_KEY is required");
  output = process.env.VIDEOQ_HIGHLIGHT_OUTPUT ?? root;
  mkdirSync(output, { recursive: true });
});

it.skipIf(!enabled).each([1, 2, 3])("captures short highlight request, run %i", async run => {
  const question = "見どころを教えて";
  const started = Date.now();
  const progress: ChatToolProgressEvent[] = [];
  const calls = new Map<string, unknown>();
  const evidence = new Map<string, unknown>();
  const visualUsage: Record<string, unknown>[] = [];
  const fetchImpl = globalThis.fetch;
  const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const body = input instanceof Request ? await input.clone().text() : typeof init?.body === "string" ? init.body : "";
    if (body) {
      const request = JSON.parse(body);
      for (const message of request.messages ?? []) {
        for (const call of message.tool_calls ?? []) calls.set(call.id, call.function);
        if (message.role === "tool") evidence.set(message.tool_call_id, message.content);
      }
    }
    return fetchImpl(input, init);
  });
  const info = vi.spyOn(console, "info").mockImplementation(value => {
    if (typeof value === "string" && value.startsWith("{")) {
      const event = JSON.parse(value);
      if (event.event === "visual_inspection") visualUsage.push(event);
    }
  });
  let final;
  let failure: string | undefined;
  try {
    for await (const chunk of streamRag(env, {
      ownerUserId: "fixture-owner", videoIds: [fixture.id], courseId: 1, locale: "ja",
      messages: [{ role: "user", content: question }],
    })) {
      if ("toolProgress" in chunk) progress.push(chunk.toolProgress);
      if ("final" in chunk) final = chunk.final;
    }
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    info.mockRestore(); fetchSpy.mockRestore();
    writeFileSync(join(output, `highlight-${run}.json`), JSON.stringify({
      question, model: env.LLM_MODEL, elapsed_seconds: (Date.now() - started) / 1000,
      calls: [...calls.values()], evidence: [...evidence.values()], progress, visualUsage, final, failure,
    }, null, 2));
  }
  expect(final?.answer.segments.length).toBeGreaterThan(0);
  expect(progress.some(p => p.tool === "focus_clip" && p.status === "complete")).toBe(true);
  expect(visualUsage.filter(record => record.mode === "focus").length).toBeGreaterThan(0);
  expect(visualUsage.length).toBeLessThanOrEqual(4);
  expect(visualUsage.reduce((sum, record) => sum + Number(record.frames), 0)).toBeLessThanOrEqual(48);
  console.log(JSON.stringify({ run, text: chatAnswerText(final.answer), elapsed_seconds: (Date.now() - started) / 1000 }));
}, 300_000);
