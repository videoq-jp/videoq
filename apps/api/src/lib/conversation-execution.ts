import { openConversation } from '../repositories/conversation-repository';
import { runRag, streamRag, type RagParams, type RagStreamChunk } from './rag';
import { runConversation, streamConversation, type ConversationRequest, type ConversationExecutionDependencies } from '../features/chat/execution-service';
import type { Bindings } from '../types/bindings';
export { ConversationCommitError } from '../features/chat/execution-service';

type Memory = Awaited<ReturnType<typeof openConversation>>['saver'];
function dependencies(env: Bindings, params: RagParams, signal?: AbortSignal): ConversationExecutionDependencies<Memory, RagStreamChunk> {
  return {
    open: (scope, id, resume) => openConversation(env, scope, id, resume),
    run: memory => runRag(env, memory ? { ...params, memory } : params),
    stream: async function* (memory) {
      for await (const chunk of streamRag(env, memory ? { ...params, memory } : params, signal)) {
        if ('final' in chunk) yield { kind: 'final', value: chunk.final };
        else yield { kind: 'event', value: chunk };
      }
    },
    beforeCommit: () => signal?.throwIfAborted(),
    closeFailed: () => console.error(JSON.stringify({ event: 'conversation_close_failed' })),
  };
}
export function runChatRag(env: Bindings, params: RagParams, request: ConversationRequest) {
  return runConversation(request, dependencies(env, params));
}
export async function* streamChatRag(env: Bindings, params: RagParams, request: ConversationRequest, signal?: AbortSignal): AsyncGenerator<RagStreamChunk> {
  for await (const chunk of streamConversation(request, dependencies(env, params, signal))) {
    if (chunk.kind === 'final') yield { final: chunk.value };
    else yield chunk.value;
  }
}
