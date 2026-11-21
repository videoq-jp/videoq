import { and, eq, sql } from "drizzle-orm";
import { users } from "../../db/schema";
import {
  failedAiReservation,
  quotaAllowsNext,
} from "../../application/quota-policy";
import { quotaDrizzleComparison } from "../quota-policy-sql";
import { withDb } from "../../db/pool";
import type { Bindings } from "../../types/bindings";
import type {
  AiAnswerReservation,
  AiAnswerReservationResult,
  AiQuotaRepository,
} from "../contracts/ai-quota";

const stale = sql`(${users.usagePeriodStart} IS NULL OR date_trunc('month',${users.usagePeriodStart},'UTC')<>date_trunc('month',now(),'UTC'))`;
const used = sql`CASE WHEN ${stale} THEN 0 ELSE ${users.usedAiAnswers} END`;
/** Reserve the quota with one guarded update so concurrent requests cannot exceed it. */
export async function reserveAiAnswerUsage(
  env: Bindings,
  userId: string,
): Promise<AiAnswerReservationResult> {
  return withDb(env, async (db) => {
    const [reservation] = await db
      .update(users)
      .set({
        usedAiAnswers: sql`CASE WHEN ${stale} THEN 1 ELSE ${users.usedAiAnswers}+1 END`,
        usedProcessingSeconds: sql`CASE WHEN ${stale} THEN 0 ELSE ${users.usedProcessingSeconds} END`,
        usagePeriodStart: sql`CASE WHEN ${stale} THEN now() ELSE ${users.usagePeriodStart} END`,
      })
      .where(
        and(
          eq(users.id, userId),
          sql`${users.isOverQuota} IS NOT TRUE`,
          quotaAllowsNext(used, users.aiAnswersLimit, quotaDrizzleComparison),
        ),
      )
      .returning({
        usagePeriodStart: sql<string>`${users.usagePeriodStart}::text`,
        planCode: users.planCode,
        quotaSource: users.quotaSource,
      });
    if (reservation) return { reservation: { userId, ...reservation } };
    const [state] = await db
      .select({ overQuota: users.isOverQuota, limit: users.aiAnswersLimit })
      .from(users)
      .where(eq(users.id, userId));
    return failedAiReservation(
      state
        ? {
            overQuota: Boolean(state.overQuota),
            limit: state.limit === null ? null : Number(state.limit),
          }
        : null,
    );
  });
}
/** Fence the return by the original period so it cannot debit a new month. */
export async function releaseAiAnswerReservation(
  env: Bindings,
  reservation: AiAnswerReservation,
): Promise<void> {
  await withDb(env, async (db) => {
    await db
      .update(users)
      .set({ usedAiAnswers: sql`greatest(${users.usedAiAnswers}-1,0)` })
      .where(
        and(
          eq(users.id, reservation.userId),
          sql`${users.usagePeriodStart}=${reservation.usagePeriodStart}::timestamptz`,
        ),
      );
  });
}
export function createPostgresAiQuotaRepository(
  env: Bindings,
): AiQuotaRepository {
  return {
    reserve: (userId) => reserveAiAnswerUsage(env, userId),
    release: (reservation) => releaseAiAnswerReservation(env, reservation),
  };
}
