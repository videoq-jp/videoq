import { chatCompletionResponse } from "../helpers/chat-completion-response";
import { stalledChatResponse } from "../helpers/stalled-chat-response";
import { chatAnswerText } from "@videoq/trpc/chat";
import { describe, expect, it, vi } from "vitest";
import type { SceneHit } from "../../src/repositories/vector-repository";
import type { Bindings } from "../../src/types/bindings";
import type { RagStreamChunk } from "../../src/lib/rag";

/**
 * ReAct（createAgent / LangGraph）が Workers ランタイムで動くことの確認。
 * Node の unit テストと違い workerd 上で実行されるので、AsyncLocalStorage など
 * nodejs_compat 依存の有無をここで検出する。
 */

const searchCalls: string[] = [];
let opened = 0;
const videoSelections: (readonly number[] | undefined)[] = [];

vi.mock("../../src/repositories/vector-repository", () => ({
  openSceneSearch: async () => {
    opened += 1;
    return {
    search: async (query: string, videoIds?: readonly number[]): Promise<SceneHit[]> => {
      searchCalls.push(query);
      videoSelections.push(videoIds);
      return [
        {
          content: "scene text A",
          videoId: 60,
          videoTitle: "Video A",
          startTime: "00:00:10",
          endTime: "00:00:20",
        },
      ];
    },
    close: async () => {},
    };
  },
}));

vi.mock("../../src/repositories/course-repository", () => ({
  getCourseInfo: async () => ({
    name: "Course A", description: "Course description", video_count: 1,
    videos: [{ id: 60, title: "Video A", description: "", order: 0, status: "processing" }],
  }),
}));

vi.mock("../../src/repositories/video-evidence-repository", () => ({
  getVideoEvidence: async () => null,
}));

const { runRag, streamRag } = await import("../../src/lib/rag");

const ENV = {
  OPENAI_API_KEY: "sk-test",
  OPENAI_BASE_URL: "https://openai.test/v1",
  LLM_MODEL: "local-codex-model",
} as unknown as Bindings;

describe("RAG agent in the Workers runtime", () => {
  it("aborts the no-course provider before closing its prefetched iterator", async () => {
    let upstream: AbortSignal | undefined;
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      upstream = init.signal!;
      return stalledChatResponse(upstream, () => {}, true, '{"segments":[{"text":"First');
    });
    const stream = streamRag(ENV, {
      messages: [{ role: "user", content: "Question" }],
      ownerUserId: "00000000-0000-4000-8000-000000000005", videoIds: null, locale: null,
    });
    try {
      expect((await stream.next()).value).toEqual({ part: { type: "text", segmentIndex: 0, text: "First" } });
      await stream.return();
      expect(upstream?.aborted).toBe(true);
    } finally {
      await stream.return();
      vi.unstubAllGlobals();
    }
  });

  it.each([false, true].flatMap((streaming) => ["search", "metadata", "metadata-search"].map((mode) => ({ streaming, mode })))) ("runs the $mode tool loop (stream=$streaming)", async ({ streaming, mode }) => {
    let call = 0;
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      expect(url).toBe("https://openai.test/v1/chat/completions");
      expect(JSON.parse(String(init.body)).stream).toBe(streaming);
      call += 1;
      const metadataTurn = mode !== "search" && call === 1;
      const searchTurn = mode === "search" ? call === 1 : mode === "metadata-search" && call === 2;
      const toolName = metadataTurn ? "get_course_info" : "search_scenes";
      const args = metadataTurn ? { video_limit: 20, video_offset: 0 } : { query: "pgvector", video_ids: mode === "metadata-search" ? [60] : null };
      const answer = JSON.stringify({ segments: [{ text: mode === "metadata" ? "Course A has one video." : "Answer.", sourceIds: mode === "metadata" ? [] : [1] }] });
      if (metadataTurn || searchTurn) {
        return chatCompletionResponse({
          choices: [
            {
              finish_reason: "tool_calls",
              message: {
                role: "assistant",
                content: null,
                tool_calls: [
                  {
                    id: `call_${call}`,
                    type: "function",
                    function: {
                      name: toolName,
                      arguments: JSON.stringify(args),
                    },
                  },
                ],
              },
            },
          ],
        }, streaming, `chatcmpl-${call}`);
      }
      return chatCompletionResponse({
        choices: [{ finish_reason: "stop", message: { role: "assistant", content: answer } }],
      }, streaming, `chatcmpl-${call}`);
    });

    try {
      const params = {
        messages: [{ role: "user", content: "what is pgvector?" }],
        ownerUserId: "00000000-0000-4000-8000-000000000005",
        videoIds: [60],
        locale: null,
        courseId: mode === "search" ? null : 3,
      };
      const chunks: RagStreamChunk[] = [];
      const result = streaming
        ? await (async () => {
            for await (const chunk of streamRag(ENV, params)) chunks.push(chunk);
            const final = chunks.find((chunk) => "final" in chunk);
            if (!final) throw new Error("Missing final answer");
            expect(chunks.filter(chunk => "part" in chunk && chunk.part.type === "text").map(chunk => "part" in chunk && chunk.part.type === "text" ? chunk.part.text : "").join("")).toBe(chatAnswerText(final.final.answer));
            return final.final;
          })()
        : await runRag(ENV, params);

      if (mode === "metadata") {
        expect(searchCalls).toEqual([]);
        expect(opened).toBe(0);
        expect(chatAnswerText(result.answer)).toBe("Course A has one video.");
        expect(result.answer.sources).toEqual([]);
        expect(result.retrievedContexts?.[0]).toContain("Course metadata");
        return;
      }
      expect(searchCalls).toEqual(["pgvector"]);
      expect(chatAnswerText(result.answer)).toBe("Answer.");
      expect(result.answer.sources).toEqual([
        { id: 1, video_id: 60, title: "Video A", start_time: "00:00:10", end_time: "00:00:20" },
      ]);
      expect(result.retrievedContexts?.[0]).toBe("scene text A");
      if (mode === "metadata-search") {
        expect(videoSelections).toEqual([[60]]);
        expect(result.retrievedContexts?.[1]).toContain("Course metadata");
      }
    } finally {
      vi.unstubAllGlobals();
      searchCalls.length = 0;
      opened = 0;
      videoSelections.length = 0;
    }
  });
});
