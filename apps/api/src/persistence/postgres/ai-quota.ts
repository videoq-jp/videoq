import { withClient } from "../../db/pool";
import type { Bindings } from "../../types/bindings";
import type { AiAnswerReservation, AiAnswerReservationResult,AiQuotaRepository } from "../contracts/ai-quota";

const MONTHLY_USAGE_IS_STALE_SQL = `(
  usage_period_start IS NULL
  OR date_trunc('month', usage_period_start, 'UTC')
     <> date_trunc('month', now(), 'UTC')
)`;

const RESERVE_AI_ANSWER_SQL = `UPDATE users
   SET used_ai_answers = CASE
         WHEN ${MONTHLY_USAGE_IS_STALE_SQL} THEN 1
         ELSE used_ai_answers + 1
       END,
       used_processing_seconds = CASE
         WHEN ${MONTHLY_USAGE_IS_STALE_SQL} THEN 0
         ELSE used_processing_seconds
       END,
       usage_period_start = CASE
         WHEN ${MONTHLY_USAGE_IS_STALE_SQL} THEN now()
         ELSE usage_period_start
       END
 WHERE id = $1
   AND is_over_quota IS NOT TRUE
   AND (
     ai_answers_limit IS NULL
     OR CASE
          WHEN ${MONTHLY_USAGE_IS_STALE_SQL} THEN 0
          ELSE used_ai_answers
        END < ai_answers_limit
   )
 RETURNING usage_period_start::text AS usage_period_start,
           plan_code, quota_source`;

/**
 * LLM 呼び出し前に AI 回答枠を予約する。
 *
 * 上限判定・UTC 月替わりリセット・加算を単一の条件付き UPDATE にまとめることで、
 * 同じ所有者に対する並行リクエストでも上限を超えて予約されないようにする。
 */
export async function reserveAiAnswerUsage(
  env: Bindings,
  userId: string,
): Promise<AiAnswerReservationResult> {
  return withClient(env, async (client) => {
    const reserved = await client.query<{ usage_period_start: string; plan_code: string; quota_source: string }>(
      RESERVE_AI_ANSWER_SQL,
      [userId],
    );

    const reservation = reserved.rows[0];
    if (reservation) {
      return {
        reservation: {
          userId,
          usagePeriodStart: reservation.usage_period_start,
          planCode: reservation.plan_code,
          quotaSource: reservation.quota_source,
        },
      };
    }

    const state = await client.query<{
      is_over_quota: boolean;
      ai_answers_limit: number | null;
    }>(
      `SELECT is_over_quota, ai_answers_limit
         FROM users
        WHERE id = $1`,
      [userId],
    );
    const row = state.rows[0];
    if (!row) throw new Error("Quota owner not found.");
    if (row.is_over_quota) return { overQuota: true } as const;

    const limit = row.ai_answers_limit;
    if (limit === null) {
      throw new Error("Failed to reserve an unlimited AI answer quota.");
    }
    return { exceeded: true, limit: Number(limit) } as const;
  });
}

/**
 * 回答を利用者へ完了できなかった場合に予約を返却する。
 * 月替わり後の新しい利用期間を誤って減算しないよう、予約時の期間も条件に含める。
 */
export async function releaseAiAnswerReservation(
  env: Bindings,
  reservation: AiAnswerReservation,
): Promise<void> {
  return withClient(env, async (client) => {
    await client.query(
      `UPDATE users
          SET used_ai_answers = GREATEST(used_ai_answers - 1, 0)
        WHERE id = $1
          AND usage_period_start = $2::timestamptz`,
      [reservation.userId, reservation.usagePeriodStart],
    );
  });
}


export function createPostgresAiQuotaRepository(env:Bindings):AiQuotaRepository {
  return {reserve:userId=>reserveAiAnswerUsage(env,userId),release:reservation=>releaseAiAnswerReservation(env,reservation)};
}
