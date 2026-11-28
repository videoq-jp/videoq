/** Local evaluation follows the repository's due time; it never rewrites leases. */
export function evaluationWakeup(nextWakeup: number | null, now: number): { kind: 'idle' } | { kind: 'run' } | { kind: 'wait'; until: number; delayMs: number } {
  if (!Number.isSafeInteger(now) || now < 0 || (nextWakeup !== null && (!Number.isSafeInteger(nextWakeup) || nextWakeup < 0))) throw new Error('INVALID_EVALUATION_WAKEUP');
  if (nextWakeup === null) return { kind: 'idle' };
  if (nextWakeup <= now) return { kind: 'run' };
  return { kind: 'wait', until: nextWakeup, delayMs: Math.min(30_000, nextWakeup - now) };
}

export function evaluationBatchContinuation(reason: string, calls: number, nextWakeup: number | null): boolean {
  if (!Number.isSafeInteger(calls) || calls < 0) throw new Error('INVALID_EVALUATION_CALL_COUNT');
  if (reason === 'retry_wait') {
    if (nextWakeup === null || !Number.isSafeInteger(nextWakeup) || nextWakeup < 0) throw new Error('INVALID_EVALUATION_WAKEUP');
    return true;
  }
  if (reason !== 'invocation_budget') return false;
  if (calls === 0) throw new Error('CONTINUATION_WITHOUT_MODEL_PROGRESS');
  return true;
}
