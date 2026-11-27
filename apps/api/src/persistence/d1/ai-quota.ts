import { and, eq, sql } from "drizzle-orm";
import { createD1Connection } from "../../db/d1/connection";
import { runD1Batch } from "../../db/d1/query-builders";
import { users } from "../../db/schema/sqlite";
import {
  failedAiReservation,
  quotaAllowsNext,
} from "../../domain/billing/quota-policy";
import { quotaDrizzleComparison } from "../quota-policy-sql";
import type { AiQuotaRepository } from "../contracts/ai-quota";

export function createD1AiQuotaRepository(
  database: D1Database,
): AiQuotaRepository {
  const db = createD1Connection(database);
  const current = sql`strftime('%Y-%m',${users.usagePeriodStart})=strftime('%Y-%m','now')`;
  const used = sql`CASE WHEN ${current} THEN ${users.usedAiAnswers} ELSE 0 END`;
  return {
    async reserve(userId) {
      const result = await runD1Batch<{
        usage_period_start: string;
        plan_code: string;
        quota_source: string;
        is_over_quota: number;
        ai_answers_limit: number | null;
      }>(database, [
        db
          .update(users)
          .set({
            usedAiAnswers: sql`(${used})+1`,
            usedProcessingSeconds: sql`CASE WHEN ${current} THEN ${users.usedProcessingSeconds} ELSE 0 END`,
            usagePeriodStart: sql`CASE WHEN ${current} THEN ${users.usagePeriodStart} ELSE strftime('%Y-%m-%dT%H:%M:%fZ','now') END`,
          })
          .where(
            and(
              eq(users.id, userId),
              sql`${users.isOverQuota} IS NOT TRUE`,
              sql`(${used})<2147483647`,
              quotaAllowsNext(
                used,
                users.aiAnswersLimit,
                quotaDrizzleComparison,
              ),
            ),
          )
          .returning({
            usagePeriodStart: users.usagePeriodStart,
            planCode: users.planCode,
            quotaSource: users.quotaSource,
          }),
        db
          .select({
            isOverQuota: users.isOverQuota,
            aiAnswersLimit: users.aiAnswersLimit,
          })
          .from(users)
          .where(eq(users.id, userId)),
      ]);
      const row = result[0].results[0];
      if (row)
        return {
          reservation: {
            userId,
            usagePeriodStart: row.usage_period_start,
            planCode: row.plan_code,
            quotaSource: row.quota_source,
          },
        };
      const state = result[1].results[0];
      return failedAiReservation(
        state
          ? {
              overQuota: Boolean(state.is_over_quota),
              limit: state.ai_answers_limit,
            }
          : null,
      );
    },
    async release(reservation) {
      await db
        .update(users)
        .set({ usedAiAnswers: sql`max(${users.usedAiAnswers}-1,0)` })
        .where(
          and(
            eq(users.id, reservation.userId),
            eq(users.usagePeriodStart, reservation.usagePeriodStart),
          ),
        )
        .run();
    },
  };
}
