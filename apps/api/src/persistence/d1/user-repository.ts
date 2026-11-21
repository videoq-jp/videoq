import { eq, sql } from "drizzle-orm";
import { accountEntitlementSummary } from "../../application/account-summary";
import { createD1Connection } from "../../db/d1/connection";
import { users, videos } from "../../db/schema/sqlite";
import type { UserRepository } from "../contracts/user-repository";
import { createD1UserSecretsRepository } from "./user-secrets";

export function createD1UserRepository(database: D1Database): UserRepository {
  const db = createD1Connection(database);
  return {
    ...createD1UserSecretsRepository(database),
    async getCurrentUser(userId) {
      const [r] = await db
        .select({
          user: users,
          videoCount: sql<number>`(${db
            .select({ value: sql<number>`count(*)` })
            .from(videos)
            .where(eq(videos.userId, users.id))})`,
          usedUploadBytes: sql<number>`CASE WHEN strftime('%Y-%m', ${users.uploadUsagePeriodStart}) = strftime('%Y-%m', 'now')
          THEN ${users.usedUploadBytes} ELSE 0 END`,
          uploadResetsAt: sql<string>`strftime('%Y-%m-%dT%H:%M:%fZ', 'now', 'start of month', '+1 month')`,
        })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1);
      if (!r) return null;
      const u = r.user;
      return {
        id: u.id,
        username: u.username,
        email: u.email,
        ...accountEntitlementSummary({
          role: u.role,
          planCode: u.planCode,
          quotaSource: u.quotaSource,
          monthlyLimitGb: u.monthlyUploadLimitGb,
          storageLimitGb: u.storageLimitGb,
          processingLimitMinutes: u.processingLimitMinutes,
        }),
        video_count: r.videoCount,
        used_upload_bytes: r.usedUploadBytes,
        upload_resets_at: new Date(r.uploadResetsAt).toISOString(),
        used_storage_bytes: u.usedStorageBytes,
        used_processing_seconds: u.usedProcessingSeconds,
        used_ai_answers: u.usedAiAnswers,
        ai_answers_limit: u.aiAnswersLimit,
        is_over_quota: u.isOverQuota,
        subscription_status: u.subscriptionStatus,
      };
    },
  };
}
