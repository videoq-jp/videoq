import { streamChatHistoryCsv } from '../shared/csv';
import { createChatHistoryService } from '../features/chat/service';
import { getCourseChatHistory, deleteCourseChatLogs, getCourseChatAnalytics, updateChatLogFeedback, shareSlugExists as shareExists, iterateCourseChatHistoryForExport } from '../repositories/chat-repository';
import { courseOwnedBy } from '../repositories/course-repository';
import { verifyChatFeedbackToken } from '../lib/chat-feedback-token';
import type { Bindings } from '../types/bindings';

function chatHistoryService(env: Bindings) {
  return createChatHistoryService({
    chat: {
      shareExists: slug => shareExists(env, slug),
      history: (id, user, limit, offset) => getCourseChatHistory(env, id, user, limit, offset),
      deleteHistory: (id, user) => deleteCourseChatLogs(env, id, user),
      analytics: (id, user) => getCourseChatAnalytics(env, id, user),
      feedback: (id, feedback, options) => updateChatLogFeedback(env, id, feedback, options),
    },
    courseOwnedBy: (id, user) => courseOwnedBy(env, id, user),
    historyRows: (id, user) => iterateCourseChatHistoryForExport(env, id, user),
    verifyFeedbackToken: (id, slug, token) => verifyChatFeedbackToken(env, id, slug, token),
  });
}
type Service = ReturnType<typeof createChatHistoryService>;
export async function shareSlugExists(env: Bindings, ...args: Parameters<Service["shareSlugExists"]>) {
  return chatHistoryService(env).shareSlugExists(...args);
}
export async function historyForCourse(env: Bindings, ...args: Parameters<Service["historyForCourse"]>) {
  return chatHistoryService(env).historyForCourse(...args);
}
export async function resetHistory(env: Bindings, ...args: Parameters<Service["resetHistory"]>) {
  return chatHistoryService(env).resetHistory(...args);
}
export async function analyticsForCourse(env: Bindings, ...args: Parameters<Service["analyticsForCourse"]>) {
  return chatHistoryService(env).analyticsForCourse(...args);
}
export async function exportHistoryCsv(env: Bindings, ...args: Parameters<Service["exportHistoryCsv"]>) {
  const result = await chatHistoryService(env).exportHistoryCsv(...args);
  if ("rows" in result) return { filename: result.filename, body: streamChatHistoryCsv(result.rows) };
  return { notFound: true } as const;
}
export async function submitFeedback(env: Bindings, ...args: Parameters<Service["submitFeedback"]>) {
  return chatHistoryService(env).submitFeedback(...args);
}
