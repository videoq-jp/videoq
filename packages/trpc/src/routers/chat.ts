import { protectedProcedure, publicProcedure, t } from "../init";
import { chatInputSchemas } from "../inputs/chat";
import { outputSchemas } from "../outputs";

export const chatRouter = t.router({
  conversations: publicProcedure.input(chatInputSchemas["chat.conversations"]).output(outputSchemas["chat.conversations"])
    .query(({ ctx, input }) => ctx.call("chat.conversations", input)),
  conversation: publicProcedure.input(chatInputSchemas["chat.conversation"]).output(outputSchemas["chat.conversation"])
    .query(({ ctx, input }) => ctx.call("chat.conversation", input)),
  deleteConversation: publicProcedure.input(chatInputSchemas["chat.deleteConversation"]).output(outputSchemas["chat.deleteConversation"])
    .mutation(({ ctx, input }) => ctx.call("chat.deleteConversation", input)),
  send: publicProcedure
    .input(chatInputSchemas["chat.send"])
    .output(outputSchemas["chat.send"])
    .mutation(({ ctx, input }) => ctx.call("chat.send", input)),
  feedback: publicProcedure
    .input(chatInputSchemas["chat.feedback"])
    .output(outputSchemas["chat.feedback"])
    .mutation(({ ctx, input }) => ctx.call("chat.feedback", input)),
  history: protectedProcedure
    .input(chatInputSchemas["chat.history"])
    .output(outputSchemas["chat.history"])
    .query(({ ctx, input }) => ctx.call("chat.history", input)),
  resetHistory: protectedProcedure
    .input(chatInputSchemas["chat.resetHistory"])
    .output(outputSchemas["chat.resetHistory"])
    .mutation(({ ctx, input }) => ctx.call("chat.resetHistory", input)),
  analytics: protectedProcedure
    .input(chatInputSchemas["chat.analytics"])
    .output(outputSchemas["chat.analytics"])
    .query(({ ctx, input }) => ctx.call("chat.analytics", input)),
});
