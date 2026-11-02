import { protectedProcedure, publicProcedure, t } from '../init';
import { qaInputSchemas, qaOutputSchemas } from '../qa';

export const qaRouter = t.router({
  list: publicProcedure.input(qaInputSchemas['qa.list']).output(qaOutputSchemas['qa.list'])
    .query(({ ctx, input }) => ctx.call('qa.list', input)),
  get: publicProcedure.input(qaInputSchemas['qa.get']).output(qaOutputSchemas['qa.get'])
    .query(({ ctx, input }) => ctx.call('qa.get', input)),
  ask: protectedProcedure.input(qaInputSchemas['qa.ask']).output(qaOutputSchemas['qa.ask'])
    .mutation(({ ctx, input }) => ctx.call('qa.ask', input)),
  updateQuestion: protectedProcedure.input(qaInputSchemas['qa.updateQuestion']).output(qaOutputSchemas['qa.updateQuestion'])
    .mutation(({ ctx, input }) => ctx.call('qa.updateQuestion', input)),
  deleteQuestion: protectedProcedure.input(qaInputSchemas['qa.deleteQuestion']).output(qaOutputSchemas['qa.deleteQuestion'])
    .mutation(({ ctx, input }) => ctx.call('qa.deleteQuestion', input)),
  reply: protectedProcedure.input(qaInputSchemas['qa.reply']).output(qaOutputSchemas['qa.reply'])
    .mutation(({ ctx, input }) => ctx.call('qa.reply', input)),
  updateReply: protectedProcedure.input(qaInputSchemas['qa.updateReply']).output(qaOutputSchemas['qa.updateReply'])
    .mutation(({ ctx, input }) => ctx.call('qa.updateReply', input)),
  deleteReply: protectedProcedure.input(qaInputSchemas['qa.deleteReply']).output(qaOutputSchemas['qa.deleteReply'])
    .mutation(({ ctx, input }) => ctx.call('qa.deleteReply', input)),
  vote: protectedProcedure.input(qaInputSchemas['qa.vote']).output(qaOutputSchemas['qa.vote'])
    .mutation(({ ctx, input }) => ctx.call('qa.vote', input)),
  feature: protectedProcedure.input(qaInputSchemas['qa.feature']).output(qaOutputSchemas['qa.feature'])
    .mutation(({ ctx, input }) => ctx.call('qa.feature', input)),
});
