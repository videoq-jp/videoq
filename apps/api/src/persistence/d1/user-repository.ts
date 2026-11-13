import { eq, sql } from "drizzle-orm";
import { MAX_VIDEO_UPLOAD_BYTES } from "@videoq/trpc/video-upload";
import { createD1Connection } from "../../db/d1/connection";
import { users } from "../../db/schema/sqlite";
import type { UserRepository } from "../contracts/user-repository";
import { createD1UserSecretsRepository } from "./user-secrets";

const GIB = 1024 ** 3;
export function createD1UserRepository(database: D1Database): UserRepository {
  const db = createD1Connection(database);
  return {
    ...createD1UserSecretsRepository(database),
    async getCurrentUser(userId) {
      const [r] = await db.select({
        user: users,
        videoCount: sql<number>`(SELECT count(*) FROM videos v WHERE v.user_id = "users"."id")`,
        usedUploadBytes: sql<number>`CASE WHEN strftime('%Y-%m', ${users.uploadUsagePeriodStart}) = strftime('%Y-%m', 'now')
          THEN ${users.usedUploadBytes} ELSE 0 END`,
        uploadResetsAt: sql<string>`strftime('%Y-%m-%dT%H:%M:%fZ', 'now', 'start of month', '+1 month')`,
      }).from(users).where(eq(users.id, userId)).limit(1);
      if (!r) return null;
      const u = r.user;
      return {
        id: u.id, username: u.username, email: u.email,
        is_admin: u.role?.split(",").includes("admin") ?? false,
        video_count: r.videoCount,
        max_video_upload_size_mb: MAX_VIDEO_UPLOAD_BYTES / 1024 ** 2,
        used_upload_bytes: r.usedUploadBytes,
        monthly_upload_limit_bytes: u.monthlyUploadLimitGb === null ? null : Math.floor(u.monthlyUploadLimitGb * GIB),
        upload_resets_at: new Date(r.uploadResetsAt).toISOString(),
        used_storage_bytes: u.usedStorageBytes,
        storage_limit_bytes: u.storageLimitGb === null ? null : Math.trunc(u.storageLimitGb * GIB),
        used_processing_seconds: u.usedProcessingSeconds,
        processing_limit_seconds: u.processingLimitMinutes === null ? null : u.processingLimitMinutes * 60,
        used_ai_answers: u.usedAiAnswers, ai_answers_limit: u.aiAnswersLimit,
        is_over_quota: u.isOverQuota,
        plan_code: u.planCode === "basic" || u.planCode === "pro" ? u.planCode : "free",
        subscription_status: u.subscriptionStatus,
        quota_source: u.quotaSource === "admin" ? "admin" : "plan",
      };
    },
  };
}
