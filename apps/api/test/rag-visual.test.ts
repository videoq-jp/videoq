import { requestBodyText } from "./helpers/request-body";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bindings } from "../src/types/bindings";
import { runRag, streamRag } from "../src/lib/rag";
import { openSceneSearch } from "../src/repositories/vector-repository";
import { chatCompletionResponse } from "./helpers/chat-completion-response";
import { focusCacheFixture } from "./helpers/focus-cache";
import type { ChatToolProgressEvent } from "@videoq/trpc/chat";

vi.mock("../src/repositories/vector-repository", () => ({ openSceneSearch: vi.fn(async () => ({
  search: async () => [{ videoId: 42, videoTitle: "Lecture", startTime: "00:00:10,000", endTime: "00:00:15,000", content: "Look at this graph." }],
  close: async () => undefined,
})) }));
vi.mock("../src/repositories/course-repository", () => ({ getCourseInfo: async () => null }));
vi.mock("../src/repositories/video-evidence-repository", () => ({ getVideoEvidence: async () => ({
  id: 42, title: "Lecture", fileKey: "private/42.mp4", sourceType: "uploaded",
  transcript: "1\n00:00:10,000 --> 00:00:15,000\nUpdated prerequisite.", transcriptTooLarge: false,
}) }));
vi.mock("../src/integrations/media", () => ({ readMediaBytes: async (_env: Bindings, key: string) => key.endsWith('.focus-v2.json') ? null : new TextEncoder().encode(JSON.stringify({
  version: 1, video_id: 42, duration_seconds: 30, sampling_interval_seconds: 5,
  frames: [{ timestamp_seconds: 12.345, jpeg_base64: "/9j/2Q==" }],
})), readMediaRange: async (_env: Bindings, _key: string, offset: number, length: number) => {
  const pack = focusCacheFixture(Array.from({ length: 8 }, (_, i) => 12_345 + i * 1000));
  return { bytes: pack.slice(offset, offset + length), etag: '"v1"', size: pack.length };
} }));
beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.unstubAllGlobals());

describe.each([false, true].flatMap(streaming =>
  [undefined, "shared-model"].map(model => ({ streaming, model })),
))("visual RAG integration (stream=$streaming, model=$model)", ({ streaming, model }) => {
  it.each([false, true, "focus"])("keeps observations private and citations stable (navigation=%s)", async navigation => {
    let agentTurns = 0;
    let visualCalls = 0;
    vi.stubGlobal("fetch", async (_url: unknown, init: RequestInit) => {
      const request = JSON.parse(requestBodyText(init.body));
      expect(request.model).toBe(model ?? "gpt-6-luna");
      if (!model) {
        expect(request.reasoning_effort).toBe("none");
        expect(request).not.toHaveProperty("max_tokens");
      } else expect(request).not.toHaveProperty("reasoning_effort");
      if (request.messages.some((m: { content: unknown }) => Array.isArray(m.content)
        && m.content.some(p => p.type === "image_url"))) {
        visualCalls++;
        expect(request.stream).toBeUndefined();
        if (navigation === "focus" && visualCalls === 3) {
          expect(JSON.stringify(request)).toContain("Viewing mode: focus");
          expect(JSON.stringify(request).match(/data:image\/jpeg/g)).toHaveLength(8);
        }
        return Response.json({ choices: [{ finish_reason: "stop", message: {
          content: JSON.stringify({ observations: [{ frame_index: 1, observation: "OBSERVATION_ONLY: the red curve rises." }] }),
        } }] });
      }
      const turn = agentTurns++;
      if (turn < 3) {
        const name = (navigation ? ["overview_video", "skim_video", navigation === "focus" ? "focus_clip" : "inspect_clip"] : ["search_scenes", "read_video_window", "inspect_clip"])[turn];
        const args = navigation && turn === 0 ? { video_id: 42, query: "Find the red curve", include_visuals: true }
          : navigation && turn === 1 ? { video_id: 42, start_seconds: 0, end_seconds: 30, query: "Locate red curve", include_visuals: true }
          : turn === 0 ? { query: "graph", video_ids: null }
          : { video_id: 42, start_seconds: 10, end_seconds: 20,
            ...(turn === 1 ? { context_seconds: 10 } : { query: "What is the red curve?" }) };
        return chatCompletionResponse({ choices: [{ finish_reason: "tool_calls", message: {
          role: "assistant", content: null,
          tool_calls: [{ id: `tool-${turn}`, type: "function", function: { name, arguments: JSON.stringify(args) } }],
        } }] }, request.stream, `agent-${turn}`);
      }
      expect(JSON.stringify(request.messages)).toContain("OBSERVATION_ONLY");
      expect(JSON.stringify(request.messages)).not.toContain("data:image");
      return chatCompletionResponse({ choices: [{ finish_reason: "stop", message: {
        role: "assistant", content: JSON.stringify({ segments: [{ text: "The red curve rises.", sourceIds: [2] }] }),
      } }] }, request.stream, "agent-final");
    });
    // No visual flag: image tools must be available for uploads by default.
    const env = { OPENAI_API_KEY: "test", OPENAI_BASE_URL: "https://models.test/v1", ...(model ? { LLM_MODEL: model } : {}) } as Bindings;
    const params = { ownerUserId: "owner", videoIds: [42], messages: [{ role: "user", content: "What is the red curve?" }], locale: "en" };
    let result;
    if (streaming) {
      let text = "";
      const activity: ChatToolProgressEvent[] = [];
      for await (const chunk of streamRag(env, params)) {
        if ("toolProgress" in chunk) activity.push(chunk.toolProgress);
        if ("part" in chunk && chunk.part.type === "text") text += chunk.part.text;
        if ("final" in chunk) result = chunk.final;
      }
      expect(text).toBe("The red curve rises.");
      const names = navigation
        ? ["overview_video", "skim_video", navigation === "focus" ? "focus_clip" : "inspect_clip"]
        : ["search_scenes", "read_video_window", "inspect_clip"];
      expect(activity).toEqual(names.flatMap((tool, index) => [
        { type: "tool_progress", call_id: index + 1, tool, status: "running" },
        { type: "tool_progress", call_id: index + 1, tool, status: "complete" },
      ]));
    } else result = await runRag(env, params);
    expect(result?.answer.sources[1]).toMatchObject({ evidence_type: "visual", video_id: 42, start_time: "00:00:12,345", end_time: "00:00:12,345" });
    expect(result?.retrievedContexts[1]).toContain("Visual observation at 00:00:12,345");
    expect(result?.retrievedContexts[0]).toContain("Updated prerequisite.");
    expect(visualCalls).toBe(navigation ? 3 : 1);
    expect(openSceneSearch).toHaveBeenCalledTimes(navigation ? 0 : 1);
    expect(agentTurns).toBe(4);
  });
});
