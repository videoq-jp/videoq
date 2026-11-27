import { expect, it, vi } from 'vitest';
import { runConversation, streamConversation, ConversationCommitError, type ConversationExecutionDependencies } from '../src/features/chat/execution-service';

const answer = { queryText: 'question', answer: { segments: [{ text: 'Answer', sourceIds: [] }], sources: [] }, retrievedContexts: [] };
const request = { id: 'conversation', question: 'original question', scope: { ownerUserId: 'owner', actorUserId: 'owner', courseId: 1, shareSlug: null } };
function fixture() {
  const conversation = { threadId: 'thread', checkpointId: null, saver: null, commit: vi.fn().mockResolvedValue({ chatLogId: 1, feedback: null }), close: vi.fn() };
  const deps = {
    open: vi.fn().mockResolvedValue(conversation), run: vi.fn().mockResolvedValue(answer),
    stream: vi.fn<ConversationExecutionDependencies<null, { text: string }>['stream']>(),
    beforeCommit: vi.fn(), closeFailed: vi.fn(),
  } satisfies ConversationExecutionDependencies<null, { text: string }>;
  return { conversation, deps };
}
it.each([undefined, 'conversation'])('rejects invalid explicit questions without opening or generating (%s)', async id => {
  const { conversation, deps } = fixture();
  const invalid = { ...request, id, question: 'question' + String.fromCharCode(0) };
  await expect(runConversation(invalid, deps)).rejects.toMatchObject({ kind: 'validation', code: 'VALIDATION_ERROR' });
  await expect(streamConversation(invalid, deps).next()).rejects.toMatchObject({ kind: 'validation', code: 'VALIDATION_ERROR' });
  for (const call of [deps.open, deps.run, deps.stream, conversation.commit, conversation.close]) expect(call).not.toHaveBeenCalled();
});
it('commits the original display question and closes even when persistence fails', async () => {
  const { conversation, deps } = fixture();
  const failure = new Error('private storage failure');
  conversation.commit.mockRejectedValue(failure);
  conversation.close.mockRejectedValue(new Error('private close failure'));
  const result = await runConversation(request, deps).catch(error => error);
  expect(result).toBeInstanceOf(ConversationCommitError);
  expect(result.cause).toBe(failure);
  expect(conversation.commit).toHaveBeenCalledWith({ ...answer, queryText: 'original question' }, undefined);
  expect(conversation.close).toHaveBeenCalledOnce();
  expect(deps.closeFailed).toHaveBeenCalledExactlyOnceWith();
});
it('does not commit a final streamed answer after cancellation', async () => {
  const { conversation, deps } = fixture();
  deps.stream.mockImplementation(async function* () {
    yield { kind: 'event', value: { text: 'partial' } };
    yield { kind: 'final', value: answer };
  });
  const cancelled = new Error('cancelled');
  deps.beforeCommit.mockImplementation(() => { throw cancelled; });
  const stream = streamConversation(request, deps);
  await expect(stream.next()).resolves.toMatchObject({ value: { kind: 'event', value: { text: 'partial' } } });
  await expect(stream.next()).rejects.toBe(cancelled);
  expect(conversation.commit).not.toHaveBeenCalled();
  expect(conversation.close).toHaveBeenCalledOnce();
});
