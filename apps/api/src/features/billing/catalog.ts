import { MAX_VIDEO_UPLOAD_BYTES } from "@videoq/trpc/video-upload";

export type PlanCode = "free" | "basic" | "pro";

export const PAID_LOOKUP_KEYS = [
  "basic_monthly",
  "basic_yearly",
  "pro_monthly",
  "pro_yearly",
] as const;
export type PaidLookupKey = (typeof PAID_LOOKUP_KEYS)[number];
export type BillingCurrency = "jpy" | "usd";

export function currencyForLocale(locale?: string): BillingCurrency {
  return locale === "en" ? "usd" : "jpy";
}

export type PlanEntitlements = {
  /** Compatibility field: the provider ceiling, identical for every plan. */
  maxVideoUploadSizeMb: number;
  storageLimitGb: number;
  monthlyUploadLimitGb: number;
  processingLimitMinutes: number;
  aiAnswersLimit: number;
};

export type PlanDefinition = {
  code: PlanCode;
  lookupKeys: { monthly?: PaidLookupKey; yearly?: PaidLookupKey };
  displayAmountYen: { monthly: number; yearly: number };
  displayAmountUsdCents: { monthly: number; yearly: number };
  entitlements: PlanEntitlements;
};

export const PLAN_CATALOG: Record<PlanCode, PlanDefinition> = {
  free: {
    code: "free",
    lookupKeys: {},
    displayAmountYen: { monthly: 0, yearly: 0 },
    displayAmountUsdCents: { monthly: 0, yearly: 0 },
    entitlements: {
      maxVideoUploadSizeMb: MAX_VIDEO_UPLOAD_BYTES / 1024 ** 2,
      storageLimitGb: 1,
      monthlyUploadLimitGb: 2,
      processingLimitMinutes: 45,
      aiAnswersLimit: 30,
    },
  },
  basic: {
    code: "basic",
    lookupKeys: { monthly: "basic_monthly", yearly: "basic_yearly" },
    displayAmountYen: { monthly: 1480, yearly: 14800 },
    displayAmountUsdCents: { monthly: 999, yearly: 9990 },
    entitlements: {
      maxVideoUploadSizeMb: MAX_VIDEO_UPLOAD_BYTES / 1024 ** 2,
      storageLimitGb: 20,
      monthlyUploadLimitGb: 200,
      processingLimitMinutes: 200,
      aiAnswersLimit: 500,
    },
  },
  pro: {
    code: "pro",
    lookupKeys: { monthly: "pro_monthly", yearly: "pro_yearly" },
    displayAmountYen: { monthly: 3980, yearly: 39800 },
    displayAmountUsdCents: { monthly: 2699, yearly: 26990 },
    entitlements: {
      maxVideoUploadSizeMb: MAX_VIDEO_UPLOAD_BYTES / 1024 ** 2,
      storageLimitGb: 100,
      monthlyUploadLimitGb: 1000,
      processingLimitMinutes: 1000,
      aiAnswersLimit: 2000,
    },
  },
};

const LOOKUP_TO_PLAN: Record<PaidLookupKey, PlanCode> = {
  basic_monthly: "basic",
  basic_yearly: "basic",
  pro_monthly: "pro",
  pro_yearly: "pro",
};

export function isPaidLookupKey(value: string): value is PaidLookupKey {
  return (PAID_LOOKUP_KEYS as readonly string[]).includes(value);
}

export function planCodeFromLookupKey(lookupKey: string): PlanCode | null {
  if (!isPaidLookupKey(lookupKey)) return null;
  return LOOKUP_TO_PLAN[lookupKey];
}

const ACTIVE_STATUSES = new Set(["active", "trialing", "past_due"]);

export function isUsableSubscriptionStatus(status: string | null): boolean {
  return status !== null && ACTIVE_STATUSES.has(status);
}

export function entitlementsForSubscription(
  planCode: string,
  status: string | null,
): PlanEntitlements {
  if (isUsableSubscriptionStatus(status) && isPaidPlan(planCode)) {
    return PLAN_CATALOG[planCode].entitlements;
  }
  return PLAN_CATALOG.free.entitlements;
}

export function isPaidPlan(planCode: string): planCode is "basic" | "pro" {
  return planCode === "basic" || planCode === "pro";
}
