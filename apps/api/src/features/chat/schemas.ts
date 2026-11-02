import { z } from "zod";
import { chatCourseIdSchema, chatMessagesSchema } from "@videoq/trpc/schema";

export const chatMessageBodySchema = z
  .object({
    messages: chatMessagesSchema,
    conversation_id: z.uuid().optional(),
    resume_conversation: z.boolean().optional(),
    course_id: chatCourseIdSchema,
  }).refine(body => !body.conversation_id || (body.messages.length === 1 && body.messages[0].role === 'user'), {
    message: 'A conversation request requires one user question.', path: ['messages'],
  });

export type ChatMessageBody = z.infer<typeof chatMessageBodySchema>;
