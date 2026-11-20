import { z } from "zod";
import { validConversationQuestion } from '@videoq/domain/chat';
import { chatCourseIdSchema, chatMessagesSchema } from "@videoq/trpc/schema";

export const chatMessageBodySchema = z
  .object({
    messages: chatMessagesSchema,
    conversation_id: z.uuid().optional(),
    resume_conversation: z.boolean().optional(),
    course_id: chatCourseIdSchema,
  }).refine(body => validConversationQuestion(body.messages, body.conversation_id), {
    message: 'A conversation request requires one user question.', path: ['messages'],
  });

export type ChatMessageBody = z.infer<typeof chatMessageBodySchema>;
