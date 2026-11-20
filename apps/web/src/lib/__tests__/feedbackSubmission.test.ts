import { expect, it, vi } from 'vitest';
import { submitChatFeedback, type FeedbackDependencies, type ChatFeedbackValue } from '../../application/chat-feedback';

function fixture() {
  return {
    pending: new Set<number>(), pendingChanged: vi.fn(),
    send: vi.fn(async () => ({ feedback: 'good' as ChatFeedbackValue })),
    apply: vi.fn(), refresh: vi.fn(async () => {}), failed: vi.fn(),
  } satisfies FeedbackDependencies<{ feedback: ChatFeedbackValue }>;
}
const input = { chatLogId: 7, selected: 'good' as const, messages: [{ chatLogId: 7, feedback: null }], courseId: 3 };

it('serializes pending writes synchronously and permits retry after completion', async () => {
  const deps = fixture();
  let resolve!: (result: { feedback: ChatFeedbackValue }) => void;
  deps.send.mockImplementation(() => new Promise(done => { resolve = done; }));
  const first = submitChatFeedback(input, deps);
  await submitChatFeedback(input, deps);
  expect(deps.send).toHaveBeenCalledTimes(1);
  expect(deps.pending.has(7)).toBe(true);
  expect(deps.apply).not.toHaveBeenCalled();
  resolve({ feedback: 'good' });
  await first;
  expect(deps.pending.size).toBe(0);
  expect(deps.refresh).toHaveBeenCalledWith(3, { feedback: 'good' });
  deps.send.mockResolvedValue({ feedback: null });
  await submitChatFeedback({ ...input, messages: [{ chatLogId: 7, feedback: 'good' }] }, deps);
  expect(deps.send).toHaveBeenLastCalledWith({ chatLogId: 7, feedback: null, shareSlug: undefined, feedbackToken: undefined });
});
it('requires the issued shared-answer token and never refreshes the visitor course cache', async () => {
  const deps = fixture();
  await submitChatFeedback({ ...input, shareToken: 'shared' }, deps);
  expect(deps.send).not.toHaveBeenCalled();
  expect(deps.pendingChanged).not.toHaveBeenCalled();
  await submitChatFeedback({ ...input, shareToken: 'shared', messages: [{ chatLogId: 7, feedbackToken: 'issued' }] }, deps);
  expect(deps.send).toHaveBeenCalledWith({ chatLogId: 7, feedback: 'good', shareSlug: 'shared', feedbackToken: 'issued' });
  expect(deps.refresh).not.toHaveBeenCalled();
});
it('ignores missing answers and omits shared tokens on owned answers', async () => {
  const deps = fixture();
  await submitChatFeedback({ ...input, messages: [] }, deps);
  expect(deps.send).not.toHaveBeenCalled();
  await submitChatFeedback({ ...input, messages: [{ chatLogId: 7, feedbackToken: 'old' }] }, deps);
  expect(deps.send).toHaveBeenCalledWith({ chatLogId: 7, feedback: 'good', shareSlug: undefined, feedbackToken: undefined });
});
it.each(['send', 'refresh'] as const)('releases the pending write after %s fails and retains only saved feedback', async operation => {
  const deps = fixture();
  const error = new Error(operation);
  deps[operation].mockRejectedValue(error);
  await submitChatFeedback(input, deps);
  expect(deps.pending.size).toBe(0);
  expect(deps.pendingChanged).toHaveBeenCalledTimes(2);
  expect(deps.failed).toHaveBeenCalledWith(error);
  expect(deps.apply).toHaveBeenCalledTimes(operation === 'send' ? 0 : 1);
});
