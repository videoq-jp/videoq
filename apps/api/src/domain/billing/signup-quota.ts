import { PLAN_CATALOG } from './billing-catalog';

/**
 * Free-tier quotas applied when a new account is created via signup.
 * Override processing/storage/AI quotas with DEFAULT_* env vars.
 * MAX_VIDEO_UPLOAD_SIZE_MB is deprecated and ignored.
 * The plan catalog is the single source of free-tier defaults.
 *
 * Semantics for nullable limits:
 * - positive number → capped quota
 * - 0 → hard zero (cannot use)
 * - null → unlimited
 */

export type SignupQuotaDefaults = {
  maxVideoUploadSizeMb: number;
  storageLimitGb: number | null;
  monthlyUploadLimitGb: number | null;
  processingLimitMinutes: number | null;
  aiAnswersLimit: number | null;
};

/**
 * Parse a nullable numeric env limit.
 * - unset / empty → fallback
 * - "null" / "unlimited" → null (unlimited)
 * - finite nonnegative number → that number
 * - integer columns also require a PostgreSQL int4-compatible value
 */
export function parseNullableLimit(
  raw: string | undefined,
  fallback: number | null,
  { integer = false }: { integer?: boolean } = {},
): number | null {
  if (raw === undefined || raw.trim() === "") return fallback;
  const v = raw.trim().toLowerCase();
  if (v === "null" || v === "unlimited") return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 ||
    (integer && (!Number.isInteger(n) || n > 2_147_483_647))) return fallback;
  return n;
}

export function resolveSignupQuotaDefaults(billing: boolean, overrides: {
  monthlyUploadLimitGb?: string; storageLimitGb?: string;
  processingLimitMinutes?: string; aiAnswersLimit?: string;
}): SignupQuotaDefaults {
  const defaults = billing ? PLAN_CATALOG.free.entitlements : {
    ...PLAN_CATALOG.free.entitlements, storageLimitGb: null, monthlyUploadLimitGb: null,
    processingLimitMinutes: null, aiAnswersLimit: null,
  };
  return {
    maxVideoUploadSizeMb: defaults.maxVideoUploadSizeMb,
    monthlyUploadLimitGb: parseNullableLimit(overrides.monthlyUploadLimitGb, defaults.monthlyUploadLimitGb),
    storageLimitGb: parseNullableLimit(
      overrides.storageLimitGb,
      defaults.storageLimitGb,
    ),
    processingLimitMinutes: parseNullableLimit(
      overrides.processingLimitMinutes,
      defaults.processingLimitMinutes,
      { integer: true },
    ),
    aiAnswersLimit: parseNullableLimit(
      overrides.aiAnswersLimit,
      defaults.aiAnswersLimit,
      { integer: true },
    ),
  };
}
