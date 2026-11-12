import { z } from 'zod';

const resourceId = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const access = z.object({ courseId: resourceId, shareSlug: z.string().trim().min(1).max(64).optional() });
const question = access.extend({ questionId: z.uuid() });
const body = z.string().trim().min(1).max(10_000);
export const qaInputSchemas = {
  'qa.list': access.extend({ search: z.string().trim().max(200).default(''), videoId: resourceId.optional(),
    unanswered: z.boolean().default(false), sort: z.enum(['recent', 'votes']).default('recent'),
    offset: z.number().int().nonnegative().max(100_000).default(0), limit: z.number().int().min(1).max(50).default(20) }),
  'qa.get': question.extend({ offset: z.number().int().nonnegative().max(100_000).default(0), limit: z.number().int().min(1).max(50).default(20) }),
  'qa.ask': access.extend({ title: z.string().trim().min(1).max(200), body, videoId: resourceId.nullable().default(null) }),
  'qa.updateQuestion': question.extend({ title: z.string().trim().min(1).max(200), body }),
  'qa.deleteQuestion': question,
  'qa.reply': question.extend({ body }),
  'qa.updateReply': question.extend({ replyId: z.uuid(), body }),
  'qa.deleteReply': question.extend({ replyId: z.uuid() }),
  'qa.vote': question.extend({ voted: z.boolean() }),
  'qa.feature': question.extend({ featured: z.boolean() }),
};
const author = z.object({ name: z.string().nullable(), instructor: z.boolean(), source: z.enum(['videoq', 'moodle']).optional() });
export const qaQuestionSchema = z.object({
  id: z.uuid(), title: z.string(), body: z.string(), videoId: resourceId.nullable(), videoTitle: z.string().nullable(),
  author, createdAt: z.string(), updatedAt: z.string(), featured: z.boolean(),
  replyCount: z.number().int().nonnegative(), votes: z.number().int().nonnegative(), voted: z.boolean(),
  canEdit: z.boolean(), canDelete: z.boolean(),
});
export const qaReplySchema = z.object({ id: z.uuid(), body: z.string(), author, createdAt: z.string(), updatedAt: z.string(), canEdit: z.boolean(), canDelete: z.boolean() });
export const qaOutputSchemas = {
  'qa.list': z.object({ items: z.array(qaQuestionSchema), total: z.number().int().nonnegative(), canPost: z.boolean(), canVote: z.boolean().optional(), canModerate: z.boolean() }),
  'qa.get': z.object({ question: qaQuestionSchema, replies: z.array(qaReplySchema), replyTotal: z.number().int().nonnegative(), canPost: z.boolean(), canVote: z.boolean().optional(), canModerate: z.boolean() }),
  'qa.ask': z.object({ id: z.uuid() }),
  'qa.updateQuestion': z.object({ success: z.literal(true) }),
  'qa.deleteQuestion': z.object({ success: z.literal(true) }),
  'qa.reply': z.object({ id: z.uuid() }),
  'qa.updateReply': z.object({ success: z.literal(true) }),
  'qa.deleteReply': z.object({ success: z.literal(true) }),
  'qa.vote': z.object({ success: z.literal(true) }),
  'qa.feature': z.object({ success: z.literal(true) }),
};
export type QaQuestion = z.output<typeof qaQuestionSchema>;
export type QaReply = z.output<typeof qaReplySchema>;
