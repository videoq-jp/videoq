import type { BaseCheckpointSaver } from '@langchain/langgraph';

/** Application commit pointer; agent state and history belong to LangGraph. */
export type ConversationMemory = {
  saver: BaseCheckpointSaver;
  threadId: string;
  checkpointId: string | null;
};

export function conversationConfig(memory?: ConversationMemory) {
  return memory ? { configurable: {
    thread_id: memory.threadId,
    ...(memory.checkpointId ? { checkpoint_id: memory.checkpointId } : {}),
  } } : {};
}

export async function requireConversationCheckpoint(memory?: ConversationMemory) {
  if (memory?.checkpointId && !await memory.saver.get(conversationConfig(memory))) {
    throw new Error('The committed conversation checkpoint is unavailable.');
  }
}

export class ConversationCommitError extends Error {
  constructor(cause: unknown) { super('Could not save the completed conversation answer.', { cause }); }
}
