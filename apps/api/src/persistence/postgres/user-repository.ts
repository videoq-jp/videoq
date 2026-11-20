import type { CurrentUser } from "../contracts/user-repository";
import { eq, sql } from "drizzle-orm";
import { withDb } from "../../db/pool";
import { accountEntitlementSummary } from "../../application/account-summary";
import { currentUploadBytes } from "./storage-quota";
import { users } from "../../db/schema";
import type { Bindings } from "../../types/bindings";

/**
 * `account.me` procedure のレスポンスを組み立てる。
 */



export async function getCurrentUser(
  env: Bindings,
  userId: string,
): Promise<CurrentUser | null> {
  return withDb(env, async (db) => {
    const rows = await db
      .select({
        id: users.id,
        username: users.username,
        email: users.email,
        role: users.role,
        used_upload_bytes: currentUploadBytes,
        monthly_upload_limit_gb: users.monthlyUploadLimitGb,
        upload_resets_at: sql<string>`(date_trunc('month', CURRENT_TIMESTAMP AT TIME ZONE 'UTC') + interval '1 month') AT TIME ZONE 'UTC'`,
        used_storage_bytes: users.usedStorageBytes,
        storage_limit_gb: users.storageLimitGb,
        used_processing_seconds: users.usedProcessingSeconds,
        processing_limit_minutes: users.processingLimitMinutes,
        used_ai_answers: users.usedAiAnswers,
        ai_answers_limit: users.aiAnswersLimit,
        is_over_quota: users.isOverQuota,
        plan_code: users.planCode,
        subscription_status: users.subscriptionStatus,
        quota_source: users.quotaSource,
        // Must be "users"."id": ${users.id} becomes bare "id" → videos.id in this subquery.
        video_count: sql<number>`(SELECT count(*)::int FROM videos v WHERE v.user_id = "users"."id")`.as(
          "video_count",
        ),
      })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    if (rows.length === 0) return null;
    const r = rows[0];

    const storageLimitGb =
      r.storage_limit_gb === null ? null : Number(r.storage_limit_gb);
    const processingLimitMinutes =
      r.processing_limit_minutes === null ? null : Number(r.processing_limit_minutes);

    return {
      id: String(r.id),
      username: r.username,
      email: r.email,
      ...accountEntitlementSummary({ role: r.role, planCode: r.plan_code, quotaSource: r.quota_source,
        monthlyLimitGb: r.monthly_upload_limit_gb, storageLimitGb, processingLimitMinutes }),
      video_count: r.video_count,
      used_upload_bytes: Number(r.used_upload_bytes),
      upload_resets_at: new Date(r.upload_resets_at).toISOString(),
      used_storage_bytes: Number(r.used_storage_bytes),
      used_processing_seconds: r.used_processing_seconds,
      used_ai_answers: r.used_ai_answers,
      ai_answers_limit: r.ai_answers_limit === null ? null : Number(r.ai_answers_limit),
      is_over_quota: r.is_over_quota,
      subscription_status: r.subscription_status,
    };
  });
}
