import { describe, expect, it } from 'vitest';
import { externalTaskFailure, storageCleanupRefundRequired, storageCleanupState, validateExternalTaskDeferral, type StorageCleanupLogic } from '../src/application/external-task-policy';

const logic: StorageCleanupLogic<number | null, boolean> = {
  remaining: (used, refunded) => Math.max(0, used! - refunded!),
  limitBytes: gb => gb === null ? null : Math.floor(gb * 1024 ** 3),
  unlimited: gb => gb === null,
  atMost: (left, right) => right !== null && left! <= right,
  and: (left, right) => left && right,
  or: (left, right) => left || right,
  clearWhen: (condition, current) => condition ? false : current,
};

describe('external task policy', () => {
  it.each([[1, 10], [2, 20], [9, 2560], [10, 3600], [47, 3600], [48, 3600]])('plans failure at attempt %i', (attempt, delaySeconds) => {
    expect(externalTaskFailure(attempt)).toEqual({ dead: attempt >= 48, delaySeconds });
  });
  it('requires a positive known refund before changing quota state', () => {
    for (const bytes of [null, 0, -1]) expect(storageCleanupRefundRequired(bytes)).toBe(false);
    expect(storageCleanupRefundRequired(1)).toBe(true);
  });
  it('admits the deferral endpoints and rejects invalid durations', () => {
    for (const delay of [1, 86_400_000]) expect(() => validateExternalTaskDeferral(delay)).not.toThrow();
    for (const delay of [0, -1, 1.5, NaN, Infinity, 86_400_001]) expect(() => validateExternalTaskDeferral(delay)).toThrow('Invalid external task deferral');
  });
  it.each([
    { used: 10, refunded: 5, limitGb: null, overQuota: true, remaining: 5, expected: false },
    { used: 10, refunded: 20, limitGb: 0, overQuota: true, remaining: 0, expected: false },
    { used: 10, refunded: 5, limitGb: 0, overQuota: true, remaining: 5, expected: true },
    { used: 10, refunded: 5, limitGb: 5 / 1024 ** 3, overQuota: true, remaining: 5, expected: false },
    { used: 10, refunded: 5, limitGb: 4.9 / 1024 ** 3, overQuota: true, remaining: 5, expected: true },
    { used: 10, refunded: 5, limitGb: 0, overQuota: false, remaining: 5, expected: false },
  ])('returns capacity with current quota facts: %j', ({ remaining, expected, ...state }) => {
    expect(storageCleanupState(state, logic)).toEqual({ remaining, overQuota: expected });
  });
});
