import { chatSourceSchema, modelAnswerSchema } from "@videoq/trpc/chat";
import type { ChatAnswer, ChatSource } from "@videoq/domain/chat";
import { validateAnswerCitations } from "../features/chat/citation-policy";

/** Decode transport values and log counts only; source metadata never enters logs. */
export function validateChatAnswer(value: unknown, sources: readonly ChatSource[]): ChatAnswer {
  return validateAnswerCitations(modelAnswerSchema.parse(value), sources, {
    validateSource: source => { chatSourceSchema.parse(source); },
    onRejected: rejected => console.warn(JSON.stringify({ event: "chat_citations_rejected", ...rejected })),
  });
}
