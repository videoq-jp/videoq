import { describe, expect, it, vi } from "vitest";
import { applyChatPart, type ChatAnswer } from "@videoq/trpc/chat";
import { AnswerContentStream } from "../src/lib/answer-content-stream";
import { validateChatAnswer } from "../src/lib/chat-citations";

const sources = [1, 12].map(id => ({ id, video_id: 60, title: "Video", start_time: "00:01:00", end_time: "00:01:30" }));

describe("generation-time text and citations", () => {
  it.each([{ ids: [1, 12] }, { ids: [12, 1] }])("rejects final citations $ids that differ from the already closed segment", ({ ids }) => {
    const stream = new AnswerContentStream();
    stream.push('{"segments":[{"text":"Answer.","sourceIds":[1]}]', sources);
    const replacement = { segments: [{ text: "Answer.", sourceIds: ids }] };
    expect(() => {
      stream.push(',"segments":' + JSON.stringify(replacement.segments) + '}', sources);
      stream.finish(validateChatAnswer(replacement, sources));
    }).toThrow();
  });

  it("rejects new text appended to a segment that was already closed and sent", () => {
    const stream = new AnswerContentStream();
    stream.push('{"segments":[{"text":"Answer.","sourceIds":[1]}]', sources);
    const replacement = { segments: [{ text: "Answer. Added later.", sourceIds: [1] }] };
    expect(() => {
      stream.push(',"segments":' + JSON.stringify(replacement.segments) + '}', sources);
      stream.finish(validateChatAnswer(replacement, sources));
    }).toThrow();
  });

  it("shows text before its segment closes, but never mistakes a partial source 12 for source 1", () => {
    const stream = new AnswerContentStream();
    expect(stream.push('{"segments":[{"text":"読める本文。', sources)).toEqual([
      { type: "text", segmentIndex: 0, text: "読める本文。" },
    ]);
    expect(stream.push('","sourceIds":[1', sources)).toEqual([]);
    expect(stream.push('2]', sources)).toEqual([]);
    expect(stream.push('}', sources)).toEqual([{ type: "citation", segmentIndex: 0, sourceId: 12 }]);
    expect(stream.push(']}', sources)).toEqual([]);
    expect(stream.finish(validateChatAnswer({ segments: [{ text: "読める本文。", sourceIds: [12] }] }, sources))).toEqual([]);
  });

  it.each([
    ["日本語 🙂 [1] ", "次の文。"],
    ["$x$", "abc。"],
    ["$x$", "。次の文。"],
    ["`code`", "`続き。"],
    ["```js\nx\n``` ", "not a closing fence\n```\n終わり。"],
    ["```js\nx\n```", "\n終わり。"],
    ["\\", "[x\\]。"],
    ["$", "x$。"],
    ["\\[x", "+y\\]。"],
    ["{\"escaped\":\"\\\\\"}", "\n次の文。"],
    ["", "空segmentの後。"],
    ["各点 \u001b[0m$(x_i,y_i)$を計算します。", "投票数が多い \u001b[0m$(\\rho,\\theta)$を選びます。"],
    ["\u001b[31m赤い文字\u001b[0m。", "\u001b]8;;https://example.com\u0007リンク\u001b]8;;\u001b\\。"],
    ["制御\u0000文字\u0007を除く。", "\n既存の改行を保つ。"],
    ["第一段落。\n", "次の段落。"],
    ["第一段落。", "\n\n次の段落。"],
  ])("keeps streamed and final citations identical across every JSON split: %j + %j", (first, second) => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const answer = { segments: [first, second].map(text => ({ text, sourceIds: [1, 999, -1, 1, 12] })) };
      const expected = validateChatAnswer(answer, sources);
      const json = JSON.stringify(answer).replaceAll("🙂", "\\ud83d\\ude42");
      const partitions = Array.from({ length: json.length + 1 }, (_, index) => [json.slice(0, index), json.slice(index)]);
      partitions.push(json.split(""));
      for (const chunks of partitions) {
        const stream = new AnswerContentStream();
        const rendered: ChatAnswer = { segments: [], sources };
        let lastSegment = -1;
        const apply = (part: Parameters<typeof applyChatPart>[1]) => {
          if (part.type === "text") lastSegment = part.segmentIndex;
          else expect(part.segmentIndex).toBe(lastSegment);
          applyChatPart(rendered, part);
        };
        for (const chunk of chunks) stream.push(chunk, sources).forEach(apply);
        stream.finish(expected).forEach(apply);
        expect(rendered).toEqual(expected);
      }
    } finally {
      warning.mockRestore();
    }
  });
});
