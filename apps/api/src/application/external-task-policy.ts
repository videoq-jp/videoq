/** Failure is evaluated from the attempt that the atomic write also fences. */
export function externalTaskFailure(attempt: number): { dead: boolean; delaySeconds: number } {
  return { dead: attempt >= 48, delaySeconds: Math.min(3600, 5 * 2 ** Math.min(attempt, 10)) };
}

export function validateExternalTaskDeferral(delayMs: number): void {
  if (!Number.isSafeInteger(delayMs) || delayMs < 1 || delayMs > 86_400_000) {
    throw new Error('Invalid external task deferral');
  }
}

/** Missing or zero-sized objects must not change quota state. */
export function storageCleanupRefundRequired(bytes: number | null): boolean {
  return bytes !== null && bytes > 0;
}

/** Expressions allow recovery to use the current account inside the same write
 * as the once-only effect receipt, without reading quota facts before I/O. */
export interface StorageCleanupLogic<Value, Predicate> {
  remaining(used: Value, refunded: Value): Value;
  limitBytes(limitGb: Value): Value;
  unlimited(limit: Value): Predicate;
  atMost(left: Value, right: Value): Predicate;
  and(left: Predicate, right: Predicate): Predicate;
  or(left: Predicate, right: Predicate): Predicate;
  clearWhen(condition: Predicate, current: Predicate): Predicate;
}

export function storageCleanupState<Value, Predicate>(
  state: { used: Value; refunded: Value; limitGb: Value; overQuota: Predicate },
  logic: StorageCleanupLogic<Value, Predicate>,
): { remaining: Value; overQuota: Predicate } {
  const remaining = logic.remaining(state.used, state.refunded);
  const recovered = logic.or(logic.unlimited(state.limitGb), logic.atMost(remaining, logic.limitBytes(state.limitGb)));
  return { remaining, overQuota: logic.clearWhen(logic.and(state.overQuota, recovered), state.overQuota) };
}
