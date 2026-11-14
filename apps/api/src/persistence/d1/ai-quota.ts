import type { AiQuotaRepository } from "../contracts/ai-quota";
const CURRENT="strftime('%Y-%m',usage_period_start)=strftime('%Y-%m','now')";
const USED=`CASE WHEN ${CURRENT} THEN used_ai_answers ELSE 0 END`;
export function createD1AiQuotaRepository(database:D1Database):AiQuotaRepository {
  return {
    async reserve(userId) {
      const result=await database.batch<{usage_period_start:string;plan_code:string;quota_source:string;is_over_quota:number;ai_answers_limit:number|null}>([
        database.prepare(`UPDATE users SET used_ai_answers=(${USED})+1,
          used_processing_seconds=CASE WHEN ${CURRENT} THEN used_processing_seconds ELSE 0 END,
          usage_period_start=CASE WHEN ${CURRENT} THEN usage_period_start ELSE strftime('%Y-%m-%dT%H:%M:%fZ','now') END
          WHERE id=? AND is_over_quota IS NOT TRUE AND (${USED})<2147483647
            AND (ai_answers_limit IS NULL OR (${USED})<ai_answers_limit)
          RETURNING usage_period_start,plan_code,quota_source`).bind(userId),
        database.prepare('SELECT is_over_quota,ai_answers_limit FROM users WHERE id=?').bind(userId),
      ]);
      const row=result[0].results[0];
      if (row) return {reservation:{userId,usagePeriodStart:row.usage_period_start,planCode:row.plan_code,quotaSource:row.quota_source}};
      const state=result[1].results[0];
      if (!state) throw new Error('Quota owner not found.');
      if (state.is_over_quota) return {overQuota:true};
      if (state.ai_answers_limit===null) throw new Error('Failed to reserve an unlimited AI answer quota.');
      return {exceeded:true,limit:state.ai_answers_limit};
    },
    async release(reservation) {
      await database.prepare(`UPDATE users SET used_ai_answers=max(used_ai_answers-1,0)
        WHERE id=? AND usage_period_start=?`).bind(reservation.userId,reservation.usagePeriodStart).run();
    },
  };
}
