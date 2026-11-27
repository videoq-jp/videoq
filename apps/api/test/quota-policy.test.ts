import { expect, it } from 'vitest';
import {
  failedAiReservation, failedStorageReservation, failedUploadReservation,
  quotaAllowsAdditional, quotaAllowsNext, QUOTA_GIB_BYTES,
  validateProcessingReservation, validateStorageReservationBytes, validateUploadReservationBytes,
  type QuotaComparison,
} from '../src/domain/billing/quota-policy';

const arithmetic: QuotaComparison<number | null, boolean> = {
  isUnlimited: limit => limit === null,
  subtract: (left, right) => left === null || right === null ? null : left - right,
  atMost: (left, right) => left !== null && right !== null && left <= right,
  lessThan: (left, right) => left !== null && right !== null && left < right,
  or: (left, right) => left || right,
};

it.each([
  { used: 0, limit: 0, amount: 1, allowed: false },
  { used: 3, limit: 4, amount: 1, allowed: true },
  { used: 4, limit: 4, amount: 1, allowed: false },
  { used: 3, limit: 4, amount: 2, allowed: false },
  { used: 4, limit: 4, amount: 0, allowed: true },
  { used: 100, limit: null, amount: 1000, allowed: true },
  { used: Number.MAX_SAFE_INTEGER, limit: Number.MAX_SAFE_INTEGER, amount: 1, allowed: false },
])('reserves only when the entire amount fits: $used / $limit + $amount', ({ used, limit, amount, allowed }) => {
  expect(quotaAllowsAdditional(used, limit, amount, arithmetic)).toBe(allowed);
});

it('requires remaining capacity for a discrete answer, including a hard zero', () => {
  expect(quotaAllowsNext(0, 0, arithmetic)).toBe(false);
  expect(quotaAllowsNext(4, 5, arithmetic)).toBe(true);
  expect(quotaAllowsNext(5, 5, arithmetic)).toBe(false);
  expect(quotaAllowsNext(5, null, arithmetic)).toBe(true);
});

it('prioritizes account blocking, then storage denial, then monthly upload denial', () => {
  const state = { overQuota: false, storageLimitGb: 1, storageUsedBytes: QUOTA_GIB_BYTES, monthlyLimitGb: 2 };
  expect(failedUploadReservation({ ...state, overQuota: true }, 1)).toEqual({ overQuota: true });
  expect(failedUploadReservation(state, 1)).toEqual({ exceeded: true, limit: QUOTA_GIB_BYTES });
  expect(failedUploadReservation({ ...state, storageUsedBytes: 0 }, 1)).toEqual({ monthlyUploadExceeded: true, limit: 2 * QUOTA_GIB_BYTES });
  expect(failedUploadReservation({ ...state, storageLimitGb: null, monthlyLimitGb: null }, 1)).toBeNull();
});

it('preserves byte rounding and exact-fit precedence when diagnosing a failed write', () => {
  const state = { overQuota: false, storageLimitGb: 1.5 / QUOTA_GIB_BYTES, storageUsedBytes: 0, monthlyLimitGb: 0 };
  expect(failedUploadReservation(state, 2)).toEqual({ exceeded: true, limit: 1 });
  expect(failedUploadReservation(state, 1)).toEqual({ monthlyUploadExceeded: true, limit: 0 });
});

it('does not misreport missing owners or rejected unlimited reservations as normal exhaustion', () => {
  expect(() => failedAiReservation(null)).toThrow('Quota owner not found.');
  expect(() => failedStorageReservation(null)).toThrow('Quota owner not found.');
  expect(() => failedUploadReservation(null, 1)).toThrow('Quota owner not found.');
  expect(() => failedAiReservation({ overQuota: false, limit: null })).toThrow('Failed to reserve an unlimited AI answer quota.');
  expect(() => failedStorageReservation({ overQuota: false, limitBytes: null })).toThrow('Failed to reserve unlimited storage quota.');
  expect(failedAiReservation({ overQuota: true, limit: null })).toEqual({ overQuota: true });
  expect(failedStorageReservation({ overQuota: true, limitBytes: null })).toEqual({ overQuota: true });
  expect(failedAiReservation({ overQuota: false, limit: 0 })).toEqual({ exceeded: true, limit: 0 });
  expect(failedStorageReservation({ overQuota: false, limitBytes: 0 })).toEqual({ exceeded: true, limit: 0 });
});

it.each([NaN, Infinity, -1, 0.5, Number.MAX_SAFE_INTEGER + 1])('rejects invalid byte amounts %s before persistence', bytes => {
  expect(() => validateUploadReservationBytes(bytes)).toThrow('Upload reservation bytes');
  expect(() => validateStorageReservationBytes(bytes)).toThrow('Storage reservation bytes');
});

it('allows zero storage growth, requires positive uploads, and bounds processing reservations', () => {
  expect(() => validateStorageReservationBytes(0)).not.toThrow();
  expect(() => validateUploadReservationBytes(0)).toThrow();
  expect(() => validateUploadReservationBytes(Number.MAX_SAFE_INTEGER)).not.toThrow();
  expect(() => validateProcessingReservation(1, 2_147_483_647)).not.toThrow();
  for (const [id, seconds] of [[0, 1], [1, 0], [1, 0.5], [1, 2_147_483_648], [Infinity, 1]]) {
    expect(() => validateProcessingReservation(id, seconds)).toThrow('Processing reservation requires positive safe integers');
  }
});
