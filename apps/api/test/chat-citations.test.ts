import { describe, expect, it, vi } from "vitest";
import { answerParts, applyChatPart, chatStreamEventSchema, type ChatAnswer } from "@videoq/trpc/chat";
import { validateChatAnswer } from "../src/lib/chat-citations";

const source = { id: 1, video_id: 7, title: "Private title", start_time: "00:21:37", end_time: "00:22:20" };
describe("structured citations", () => {
  it("rejects unknown, invalid and repeated IDs without logging private values", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const answer = validateChatAnswer({ segments: [
        { text: "First [1] [99] `a[1]` $x[1]$ ", sourceIds: [1, 1, 99, 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1] },
        { text: "Second", sourceIds: [1] },
      ] }, [source]);
      expect(answer.segments).toEqual([
        { text: "First [1] [99] `a[1]` $x[1]$ ", sourceIds: [1] },
        { text: "\n\nSecond", sourceIds: [1] },
      ]);
      expect(warn).toHaveBeenCalledExactlyOnceWith(JSON.stringify({ event: "chat_citations_rejected", invalid_id: 4, unknown_id: 1, duplicate_id: 1, unsafe_position: 0 }));
    } finally { warn.mockRestore(); }
  });
  it("removes terminal controls before math boundary checks so valid citations survive", () => {
    const answer = validateChatAnswer({ segments: [
      { text: "各点 \u001b[0m$(x_i,y_i)$について、\u001b[0m$\\rho=x_i\\cos\\theta+y_i\\sin\\theta$ を計算します。", sourceIds: [1] },
      { text: "投票数が多い \u001b[0m$(\\rho,\\theta)$ の組から直線を復元します。", sourceIds: [1] },
    ] }, [source]);
    expect(answer.segments).toEqual([
      { text: "各点 $(x_i,y_i)$について、$\\rho=x_i\\cos\\theta+y_i\\sin\\theta$ を計算します。", sourceIds: [1] },
      { text: "\n\n投票数が多い $(\\rho,\\theta)$ の組から直線を復元します。", sourceIds: [1] },
    ]);
  });
  it.each([
    ["\\[a", "+b\\]"], ["$x", "+y$"], ["`a", "[1]`"], ["```ts\na", "[1]\n```"], ["~~~\na", "[1]\n~~~"],
  ])("does not insert links inside expressions split across segments", (a, b) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(validateChatAnswer({ segments: [{ text: a, sourceIds: [1] }, { text: b, sourceIds: [1] }] }, [source]).segments)
        .toEqual([{ text: a, sourceIds: [] }, { text: b, sourceIds: [1] }]);
    } finally { warn.mockRestore(); }
  });
  it("keeps stream, nonstream and stored representation identical including empty segments", () => {
    const answer = validateChatAnswer({ segments: [{ text: " ", sourceIds: [] }, { text: "", sourceIds: [1] }, { text: "回答\n", sourceIds: [1] }] }, [source]);
    const streamed: ChatAnswer = { sources: [source], segments: [] };
    for (const part of answerParts(answer)) applyChatPart(streamed, part);
    expect(streamed).toEqual(answer);
  });
  it.each([{}, { segments: [] }, { segments: [{ text: "", sourceIds: [] }] }, { segments: [{ text: "x", sourceIds: ["1"] }] }])("fails invalid answer shapes", value => {
    expect(() => validateChatAnswer(value, [])).toThrow();
  });
  it("accepts typed events only and requires explicit segment indices", () => {
    expect(chatStreamEventSchema.safeParse({ type: "content_chunk", text: "x" }).success).toBe(false);
    expect(chatStreamEventSchema.safeParse({ type: "text_delta", text: "x" }).success).toBe(false);
    expect(chatStreamEventSchema.safeParse({ type: "searching", query: "x" }).success).toBe(false);
    expect(chatStreamEventSchema.parse({ type: "text_delta", segmentIndex: 0, text: "[1]" })).toEqual({ type: "text_delta", segmentIndex: 0, text: "[1]" });
  });
});
