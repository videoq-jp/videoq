import { openConversation, type ConversationScope, type PersistConversationLog } from '../repositories/conversation-repository';
import { runRag, streamRag, type RagParams, type RagStreamChunk } from './rag';
import type { Bindings } from '../types/bindings';
import { ConversationCommitError } from './conversation';
export { ConversationCommitError } from './conversation';

type ConversationRequest = { id?: string; resume?: boolean; question?: string; scope: ConversationScope; persistLog?: PersistConversationLog };

async function closeConversation(conversation: Awaited<ReturnType<typeof openConversation>>) {
  try { await conversation.close(); }
  catch { console.error(JSON.stringify({ event: 'conversation_close_failed' })); }
}

export async function runChatRag(env: Bindings, params: RagParams, request: ConversationRequest) {
  if (!request.id) return runRag(env, params);
  const conversation = await openConversation(env, request.scope, request.id, request.resume);
  try {
    const result = await runRag(env, { ...params, memory: conversation });
    try {
      return { ...result, persistedTurn: await conversation.commit({ ...result, queryText: request.question ?? result.queryText }, request.persistLog) };
    } catch (error) { throw new ConversationCommitError(error); }
  } finally {
    await closeConversation(conversation);
  }
}

export async function* streamChatRag(
  env: Bindings, params: RagParams, request: ConversationRequest, signal?: AbortSignal,
): AsyncGenerator<RagStreamChunk> {
  if (!request.id) { yield* streamRag(env, params, signal); return; }
  const conversation = await openConversation(env, request.scope, request.id, request.resume);
  try {
    for await (const chunk of streamRag(env, { ...params, memory: conversation }, signal)) {
      if ('final' in chunk) {
        signal?.throwIfAborted();
        try { yield { final: { ...chunk.final, persistedTurn: await conversation.commit({ ...chunk.final, queryText: request.question ?? chunk.final.queryText }, request.persistLog) } }; }
        catch (error) { throw new ConversationCommitError(error); }
      } else yield chunk;
    }
  } finally {
    await closeConversation(conversation);
  }
}
