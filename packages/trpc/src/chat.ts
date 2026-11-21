import { CHAT_GENERATION_PHASES, CHAT_TOOL_NAMES } from "@videoq/domain/chat";
import { z } from "zod";
import { chatFeedbackSchema } from "./model-schemas";
import { chatSourceSchema, sourceIdSchema } from "./chat-answer";

export * from "./chat-answer";
export { appendChatPart, applyChatPart, answerParts } from "./chat-content";
export type { ChatContentPart } from "./chat-content";
export { advanceChatTextContext, parseChatText, protectedTextRanges } from "./chat-syntax";
export type { ChatTextNode } from "./chat-syntax";

const segmentIndex = z.number().int().nonnegative().safe();
export const chatToolNameSchema = z.enum(CHAT_TOOL_NAMES);
export const chatToolProgressEventSchema = z.object({
  type: z.literal("tool_progress"),
  call_id: sourceIdSchema,
  tool: chatToolNameSchema,
  status: z.enum(["running", "complete", "error"]),
});
export type { ChatToolProgressEvent } from "@videoq/domain/chat";
export const chatGenerationProgressEventSchema = z.object({
  type: z.literal("generation_progress"),
  phase: z.enum(CHAT_GENERATION_PHASES),
});
export type { ChatGenerationProgressEvent } from "@videoq/domain/chat";
export const chatStreamEventSchema = z.discriminatedUnion("type", [
  chatToolProgressEventSchema,
  chatGenerationProgressEventSchema,
  z.object({ type: z.literal("source"), source: chatSourceSchema }),
  z.object({ type: z.literal("text_delta"), segmentIndex, text: z.string() }),
  z.object({ type: z.literal("citation"), segmentIndex, sourceId: sourceIdSchema }),
  z.object({ type: z.literal("searching"), query: z.string(), search_id: sourceIdSchema }),
  z.object({ type: z.literal("search_completed"), query: z.string(), search_id: sourceIdSchema, result_count: z.number().int().nonnegative() }),
  z.object({ type: z.literal("done"), chat_log_id: sourceIdSchema.nullable(), feedback: chatFeedbackSchema, feedback_token: z.string().optional() }),
  z.object({ type: z.literal("error"), code: z.string(), message: z.string() }),
]);
export type { ChatStreamEvent } from "@videoq/domain/chat";
