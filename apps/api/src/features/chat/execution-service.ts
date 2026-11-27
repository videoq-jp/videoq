import type { GenerationResult } from '../../domain/conversation/answer-generation';
import { textValueFailure } from '@videoq/domain/text-value';
import { validationFailure } from '../../application/errors';
import type { ConversationScope, OpenConversation, PersistConversationLog } from '../../persistence/contracts/conversation';

export type ConversationRequest = { id?: string; resume?: boolean; question?: string; scope: ConversationScope; persistLog?: PersistConversationLog };
export type ConversationExecutionChunk<Event> = { kind: 'event'; value: Event } | { kind: 'final'; value: GenerationResult };
export interface ConversationExecutionDependencies<Memory, Event> {
  open(scope: ConversationScope, id: string, resume?: boolean): Promise<OpenConversation<Memory>>;
  run(memory?: OpenConversation<Memory>): Promise<GenerationResult>;
  stream(memory?: OpenConversation<Memory>): AsyncIterable<ConversationExecutionChunk<Event>>;
  beforeCommit(): void;
  closeFailed(): void;
}
export class ConversationCommitError extends Error {
  constructor(cause: unknown) { super('Could not save the completed conversation answer.', { cause }); }
}
async function close<Memory, Event>(conversation: OpenConversation<Memory>, deps: ConversationExecutionDependencies<Memory, Event>) {
  try { await conversation.close(); } catch { deps.closeFailed(); }
}
export async function runConversation<Memory, Event>(request: ConversationRequest, deps: ConversationExecutionDependencies<Memory, Event>) {
  const error = request.question === undefined ? null : textValueFailure(request.question);
  if (error) throw validationFailure(error);
  if (!request.id) return deps.run();
  const conversation = await deps.open(request.scope, request.id, request.resume);
  try {
    const result = await deps.run(conversation);
    try {
      return { ...result, persistedTurn: await conversation.commit({ ...result, queryText: request.question ?? result.queryText }, request.persistLog) };
    } catch (error) { throw new ConversationCommitError(error); }
  } finally { await close(conversation, deps); }
}
export async function* streamConversation<Memory, Event>(request: ConversationRequest, deps: ConversationExecutionDependencies<Memory, Event>): AsyncGenerator<ConversationExecutionChunk<Event>> {
  const error = request.question === undefined ? null : textValueFailure(request.question);
  if (error) throw validationFailure(error);
  if (!request.id) { yield* deps.stream(); return; }
  const conversation = await deps.open(request.scope, request.id, request.resume);
  try {
    for await (const chunk of deps.stream(conversation)) {
      if (chunk.kind === 'final') {
        deps.beforeCommit();
        try { yield { kind: 'final', value: { ...chunk.value, persistedTurn: await conversation.commit({ ...chunk.value, queryText: request.question ?? chunk.value.queryText }, request.persistLog) } }; }
        catch (error) { throw new ConversationCommitError(error); }
      } else yield chunk;
    }
  } finally { await close(conversation, deps); }
}
