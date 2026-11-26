import { adminRoleIncludes, adminBooleanRoleLogic } from '../domain/identity/admin';
import { MAX_VIDEO_UPLOAD_BYTES } from '@videoq/domain/video-upload';
import { normalizeStoredPlanCode } from '../domain/billing/billing-state';
import { QUOTA_GIB_BYTES } from '../domain/billing/quota-policy';

export type CurrentUser = {
  id: string;
  username: string;
  email: string;
  is_admin: boolean;
  video_count: number;
  max_video_upload_size_mb: number;
  used_upload_bytes: number;
  monthly_upload_limit_bytes: number | null;
  upload_resets_at: string;
  used_storage_bytes: number;
  storage_limit_bytes: number | null;
  used_processing_seconds: number;
  processing_limit_seconds: number | null;
  used_ai_answers: number;
  ai_answers_limit: number | null;
  is_over_quota: boolean;
  plan_code: "free" | "basic" | "pro";
  subscription_status: string | null;
  quota_source: "plan" | "admin";
};


/** Preserve account.me's public projection, including historical rounding and
 * role matching. Database clocks and stored usage periods remain adapter facts. */
export function accountEntitlementSummary(input: {
  role: string | null; planCode: string; quotaSource: string;
  monthlyLimitGb: number | null; storageLimitGb: number | null; processingLimitMinutes: number | null;
}): Pick<CurrentUser, 'is_admin' | 'plan_code' | 'quota_source' | 'max_video_upload_size_mb' |
  'monthly_upload_limit_bytes' | 'storage_limit_bytes' | 'processing_limit_seconds'> {
  return {
    is_admin: adminRoleIncludes(input.role, adminBooleanRoleLogic),
    plan_code: normalizeStoredPlanCode(input.planCode),
    quota_source: input.quotaSource === 'admin' ? 'admin' : 'plan',
    // Compatibility field: per-account file caps no longer apply.
    max_video_upload_size_mb: MAX_VIDEO_UPLOAD_BYTES / 1024 ** 2,
    monthly_upload_limit_bytes: input.monthlyLimitGb === null ? null : Math.floor(input.monthlyLimitGb * QUOTA_GIB_BYTES),
    storage_limit_bytes: input.storageLimitGb === null ? null : Math.trunc(input.storageLimitGb * QUOTA_GIB_BYTES),
    processing_limit_seconds: input.processingLimitMinutes === null ? null : input.processingLimitMinutes * 60,
  };
}
