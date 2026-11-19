import { describe, expect, it } from "vitest";
import { AnswerTextStream, parseModelAnswer } from "../src/lib/structured-answer";

describe("structured answer token decoding", () => {
  const text = '日本語 🙂 [1] \\n \\u1234\n```json\n{"key":"value"}\n```\n\\[x[1]\\]';
  const answer = { segments: [{ text, sourceIds: [] }, { text: " Second", sourceIds: [] }] };
  const json = JSON.stringify(answer).replace('🙂', '\\ud83d\\ude42');
  const normalized = { segments: [answer.segments[0], { text: "\n\n Second", sourceIds: [] }] };
  it("preserves escapes, Unicode, code, whitespace and TeX at every token boundary", () => {
    const partitions = Array.from({ length: json.length + 1 }, (_, i) => [json.slice(0, i), json.slice(i)]);
    partitions.push([...json]);
    for (const chunks of partitions) {
      const parser = new AnswerTextStream();
      const texts: string[] = [];
      for (const chunk of chunks) for (const delta of parser.push(chunk)) texts[delta.segmentIndex] = (texts[delta.segmentIndex] ?? "") + delta.text;
      expect(parser.finish()).toEqual(normalized);
      expect(texts).toEqual(normalized.segments.map(s => s.text));
    }
  });
  it("streams before the JSON object completes and rejects a truncated finish", () => {
    const parser = new AnswerTextStream();
    expect(parser.push('{"segments":[{"text":"Hello')).toEqual([{ segmentIndex: 0, text: "Hello" }]);
    expect(() => parser.finish()).toThrow("Invalid structured answer");
  });
  it("rejects a final JSON object that discards a segment already displayed", () => {
    const parser = new AnswerTextStream();
    parser.push('{"segments":[{"text":"First.","sourceIds":[]},{"text":"Removed.","sourceIds":[]}]');
    expect(() => {
      parser.push(',"segments":[{"text":"First.","sourceIds":[]}]}');
      parser.finish();
    }).toThrow();
  });
  it.each(['prose [1]', '```json\n{}\n```', '{"segments":[]}', '{"segments":[{"text":"x","sourceIds":[]}],"sources":[]}'])("never falls back to unstructured output", input => {
    expect(() => parseModelAnswer(input)).toThrow();
  });
});
