import { z } from "zod";
import { chatCourseIdSchema, chatMessagesSchema } from "../schema";

const page = {
  limit: z.number().int().positive().max(500).default(100),
  offset: z.number().int().nonnegative().default(0),
};

const conversationAccess = { courseId: chatCourseIdSchema, shareSlug: z.string().min(1).optional() };
export const chatInputSchemas = {
  "chat.conversations": z.object({ ...conversationAccess,
    conversationIds: z.array(z.uuid()).max(100).optional(),
    limit: z.number().int().positive().max(50).default(20), offset: z.number().int().nonnegative().default(0),
  }),
  "chat.conversation": z.object({ ...conversationAccess, conversationId: z.uuid(),
    beforeTurnId: z.string().regex(/^[1-9][0-9]{0,17}$/).optional(),
    limit: z.number().int().positive().max(100).default(50),
  }),
  "chat.deleteConversation": z.object({ ...conversationAccess, conversationId: z.uuid() }),
  "chat.send": z.object({
    messages: chatMessagesSchema,
    conversationId: z.uuid().optional(),
    resumeConversation: z.boolean().optional(),
    courseId: chatCourseIdSchema,
    shareSlug: z.string().min(1).optional(),
  }).refine(input => !input.conversationId || (input.messages.length === 1 && input.messages[0].role === 'user'), {
    message: 'A conversation request requires one user question.', path: ['messages'],
  }),
  "chat.feedback": z.object({
    chatLogId: z.number().int().positive(),
    feedback: z.enum(["good", "bad"]).nullable(),
    shareSlug: z.string().min(1).optional(),
    feedbackToken: z.string().optional(),
  }),
  "chat.history": z.object({ courseId: z.number().int().positive(), ...page }),
  "chat.resetHistory": z.object({ courseId: z.number().int().positive() }),
  "chat.analytics": z.object({ courseId: z.number().int().positive() }),
};
