import type { ChatAnswer } from "./chat-models";

/** Segment indices preserve the same structure through streaming and history. */
export type ChatContentPart =
  | { type: "text"; segmentIndex: number; text: string }
  | { type: "citation"; segmentIndex: number; sourceId: number };

export function appendChatPart(parts: ChatContentPart[], part: ChatContentPart): void {
  const last = parts.at(-1);
  if (part.type === "text" && last?.type === "text" && last.segmentIndex === part.segmentIndex) {
    last.text += part.text;
  } else parts.push({ ...part });
}

export function applyChatPart(answer: ChatAnswer, part: ChatContentPart): void {
  if (part.segmentIndex > answer.segments.length) throw new Error("Non-sequential answer segment");
  const segment = answer.segments[part.segmentIndex] ??= { text: "", sourceIds: [] };
  if (part.type === "text") segment.text += part.text;
  else if (!segment.sourceIds.includes(part.sourceId)) segment.sourceIds.push(part.sourceId);
}

export function answerParts(answer: ChatAnswer): ChatContentPart[] {
  return answer.segments.flatMap((segment, segmentIndex): ChatContentPart[] => [
    { type: "text", segmentIndex, text: segment.text },
    ...segment.sourceIds.map(sourceId => ({ type: "citation" as const, segmentIndex, sourceId })),
  ]);
}
