import { and, eq, sql } from "drizzle-orm";
import { withDb } from "../../db/pool";
import { users, videos } from "../../db/schema";
import { quotaAllowsAdditional } from "../../domain/billing/quota-policy";
import { quotaDrizzleComparison } from "../quota-policy-sql";
import type { Bindings } from "../../types/bindings";
import {
  validateProcessingReservation,
  type ProcessingQuotaRepository,
} from "../contracts/processing-quota";
export function createPostgresProcessingQuotaRepository(
  env: Bindings,
): ProcessingQuotaRepository {
  return {
    async reserve(videoId, seconds) {
      validateProcessingReservation(videoId, seconds);
      return withDb(env, (db) =>
        db.transaction(async (tx) => {
          const [video] = await tx
            .select({
              userId: videos.userId,
              processingSeconds: videos.processingSeconds,
            })
            .from(videos)
            .where(eq(videos.id, videoId))
            .for("update");
          if (!video) throw new Error("Processing video not found");
          let allowed = Number(video.processingSeconds) > 0;
          if (!allowed) {
            const current = sql`date_trunc('month',${users.usagePeriodStart},'UTC')=date_trunc('month',now(),'UTC')`;
            const used = sql`CASE WHEN ${current} THEN ${users.usedProcessingSeconds} ELSE 0 END`;
            const changed = await tx
              .update(users)
              .set({
                usedProcessingSeconds: sql`(${used})+${seconds}`,
                usedAiAnswers: sql`CASE WHEN ${current} THEN ${users.usedAiAnswers} ELSE 0 END`,
                usagePeriodStart: sql`CASE WHEN ${current} THEN ${users.usagePeriodStart} ELSE now() END`,
              })
              .where(
                and(
                  eq(users.id, video.userId),
                  sql`${users.isOverQuota} IS NOT TRUE`,
                  sql`(${used})<=9007199254740991-${seconds}`,
                  quotaAllowsAdditional(
                    used,
                    sql`${users.processingLimitMinutes}::bigint*60`,
                    sql`${seconds}`,
                    quotaDrizzleComparison,
                  ),
                ),
              )
              .returning({ id: users.id });
            allowed = changed.length > 0;
            if (allowed)
              await tx
                .update(videos)
                .set({ processingSeconds: seconds })
                .where(eq(videos.id, videoId));
          }
          const [user] = await tx
            .select({ limit: users.processingLimitMinutes })
            .from(users)
            .where(eq(users.id, video.userId));
          if (!user) throw new Error("Processing owner not found");
          return {
            allowed,
            limitSeconds: user.limit === null ? null : user.limit * 60,
          };
        }),
      );
    },
  };
}
