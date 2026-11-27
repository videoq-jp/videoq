export type QuotaReservationFailure = { overQuota: true } | { exceeded: true; limit: number };
export type StorageReservationResult = { ok: true } | QuotaReservationFailure;
export type UploadReservationFailure = QuotaReservationFailure | { monthlyUploadExceeded: true; limit: number };
export type UploadReservationResult = { ok: true; periodStart: string } | UploadReservationFailure;

export const QUOTA_GIB_BYTES = 1024 ** 3;

/** Arithmetic can evaluate facts or compose predicates in an atomic write. */
export interface QuotaComparison<Value, Predicate> {
  isUnlimited(limit: Value): Predicate;
  subtract(left: Value, right: Value): Value;
  atMost(left: Value, right: Value): Predicate;
  lessThan(left: Value, right: Value): Predicate;
  or(left: Predicate, right: Predicate): Predicate;
}

export function quotaAllowsAdditional<Value, Predicate>(
  used: Value, limit: Value, additional: Value, logic: QuotaComparison<Value, Predicate>,
): Predicate {
  return logic.or(logic.isUnlimited(limit), logic.atMost(used, logic.subtract(limit, additional)));
}

export function quotaAllowsNext<Value, Predicate>(used: Value, limit: Value, logic: QuotaComparison<Value, Predicate>): Predicate {
  return logic.or(logic.isUnlimited(limit), logic.lessThan(used, limit));
}

export function validateProcessingReservation(videoId: number, seconds: number): void {
  if (!Number.isSafeInteger(videoId) || videoId <= 0 || !Number.isSafeInteger(seconds) || seconds <= 0 || seconds > 2_147_483_647) {
    throw new Error('Processing reservation requires positive safe integers');
  }
}

export function validateUploadReservationBytes(bytes: number): void {
  if (!Number.isSafeInteger(bytes) || bytes <= 0) throw new Error('Upload reservation bytes must be a positive safe integer.');
}

export function validateStorageReservationBytes(bytes: number): void {
  if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error('Storage reservation bytes must be a non-negative safe integer.');
}

export function failedAiReservation(state: { overQuota: boolean; limit: number | null } | null): QuotaReservationFailure {
  if (!state) throw new Error('Quota owner not found.');
  if (state.overQuota) return { overQuota: true };
  if (state.limit === null) throw new Error('Failed to reserve an unlimited AI answer quota.');
  return { exceeded: true, limit: state.limit };
}

export function failedStorageReservation(state: { overQuota: boolean; limitBytes: number | null } | null): QuotaReservationFailure {
  if (!state) throw new Error('Quota owner not found.');
  if (state.overQuota) return { overQuota: true };
  if (state.limitBytes === null) throw new Error('Failed to reserve unlimited storage quota.');
  return { exceeded: true, limit: state.limitBytes };
}

/** Storage denial takes precedence over monthly upload denial. Null means the
 * database rejected for a physical representability or consistency constraint. */
export function failedUploadReservation(state: {
  overQuota: boolean; storageLimitGb: number | null; storageUsedBytes: number; monthlyLimitGb: number | null;
} | null, additionalBytes: number): UploadReservationFailure | null {
  if (!state) throw new Error('Quota owner not found.');
  if (state.overQuota) return { overQuota: true };
  const limitBytes = state.storageLimitGb === null ? null : Math.floor(state.storageLimitGb * QUOTA_GIB_BYTES);
  if (limitBytes !== null && state.storageUsedBytes > limitBytes - additionalBytes) return { exceeded: true, limit: limitBytes };
  if (state.monthlyLimitGb !== null) return { monthlyUploadExceeded: true, limit: Math.floor(state.monthlyLimitGb * QUOTA_GIB_BYTES) };
  return null;
}
