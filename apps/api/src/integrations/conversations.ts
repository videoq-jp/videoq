import { createConversationService } from '../features/chat/conversation-service';
import { createConversationRepository } from '../persistence/factory';
import { getCourseWithMembers } from '../repositories/chat-repository';
import { createChatFeedbackToken } from '../lib/chat-feedback-token';
import type { Bindings } from '../types/bindings';

type Service = ReturnType<typeof createConversationService>;
function conversationService(env: Bindings) {
  return createConversationService({
    conversations: {
      list: async (scope, input) => (await createConversationRepository(env)).list(scope, input),
      detail: async (scope, input) => (await createConversationRepository(env)).detail(scope, input),
      delete: async (scope, id) => (await createConversationRepository(env)).delete(scope, id),
    },
    courseContext: input => getCourseWithMembers(env, input),
    feedbackToken: (id, slug) => createChatFeedbackToken(env, id, slug),
  });
}
export async function conversationScope(env: Bindings, ...args: Parameters<Service["conversationScope"]>) {
  return conversationService(env).conversationScope(...args);
}
export async function listConversations(env: Bindings, ...args: Parameters<Service["listConversations"]>) {
  return conversationService(env).listConversations(...args);
}
export async function getConversation(env: Bindings, ...args: Parameters<Service["getConversation"]>) {
  return conversationService(env).getConversation(...args);
}
export async function deleteConversation(env: Bindings, ...args: Parameters<Service["deleteConversation"]>) {
  return conversationService(env).deleteConversation(...args);
}
