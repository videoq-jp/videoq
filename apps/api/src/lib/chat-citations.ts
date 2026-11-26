import { chatSourceSchema, modelAnswerSchema } from "@videoq/trpc/chat";
import type { ChatAnswer, ChatSource } from "@videoq/domain/chat";
import { normalizeAnswerTexts } from "../domain/conversation/answer-normalization";
import { validateAnswerCitations } from "../domain/conversation/citation-policy";

/** Decode transport values and log counts only; source metadata never enters logs. */
export function validateChatAnswer(value: unknown, sources: readonly ChatSource[]): ChatAnswer {
  const answer = modelAnswerSchema.parse(value);
  const texts = normalizeAnswerTexts(answer.segments.map(segment => segment.text));
  answer.segments = answer.segments.map((segment, index) => ({ ...segment, text: texts[index] }));
  return validateAnswerCitations(answer, sources, {
    validateSource: source => { chatSourceSchema.parse(source); },
    onRejected: rejected => console.warn(JSON.stringify({ event: "chat_citations_rejected", ...rejected })),
  });
}
