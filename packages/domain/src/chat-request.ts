/** Saved conversations accept a new user question, never caller-supplied history. */
export function validConversationQuestion(messages: readonly { role: string }[], conversationId?: string | null): boolean {
  return !conversationId || (messages.length === 1 && messages[0].role === 'user');
}
