import { expect, it } from 'vitest';
import { evaluationWakeup } from '../scripts/course-skill-evaluation/wakeup';

it('waits until the repository deadline for normal yields and failure backoff without extending it', () => {
  expect(evaluationWakeup(1100, 100)).toEqual({ kind: 'wait', until: 1100, delayMs: 1000 });
  expect(evaluationWakeup(80100, 100)).toEqual({ kind: 'wait', until: 80100, delayMs: 30000 });
  expect(evaluationWakeup(80100, 80100)).toEqual({ kind: 'run' });
  expect(evaluationWakeup(80100, 80101)).toEqual({ kind: 'run' });
  expect(evaluationWakeup(null, 100)).toEqual({ kind: 'idle' });
});
it('rejects invalid wakeups instead of busy looping', () => {
  expect(() => evaluationWakeup(NaN, 100)).toThrow('INVALID_EVALUATION_WAKEUP');
});
it('accepts zero-call waiting batches while rejecting zero-progress budget batches and terminal failures', async () => {
  const { evaluationBatchContinuation } = await import('../scripts/course-skill-evaluation/wakeup');
  expect(evaluationBatchContinuation('retry_wait', 0, 80100)).toBe(true);
  expect(evaluationBatchContinuation('invocation_budget', 1, null)).toBe(true);
  expect(evaluationBatchContinuation('failed', 0, null)).toBe(false);
  expect(evaluationBatchContinuation('completed', 0, null)).toBe(false);
  expect(() => evaluationBatchContinuation('invocation_budget', 0, null)).toThrow('CONTINUATION_WITHOUT_MODEL_PROGRESS');
  expect(() => evaluationBatchContinuation('retry_wait', 0, null)).toThrow('INVALID_EVALUATION_WAKEUP');
});
