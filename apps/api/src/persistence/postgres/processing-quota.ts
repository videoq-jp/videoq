import { withClient } from "../../db/pool";
import type { Bindings } from "../../types/bindings";
import { validateProcessingReservation, type ProcessingQuotaRepository } from "../contracts/processing-quota";
export function createPostgresProcessingQuotaRepository(env: Bindings): ProcessingQuotaRepository {
  return {
    async reserve(videoId, seconds) {
      validateProcessingReservation(videoId, seconds);
      return withClient(env, async client => {
        await client.query("BEGIN");
        try {
          const video = (await client.query<{ user_id: string; processing_seconds: number }>(
            "SELECT user_id,processing_seconds FROM videos WHERE id=$1 FOR UPDATE", [videoId])).rows[0];
          if (!video) throw new Error("Processing video not found");
          let allowed = Number(video.processing_seconds) > 0;
          if (!allowed) {
            const current = "date_trunc('month',usage_period_start,'UTC')=date_trunc('month',now(),'UTC')";
            const used = `CASE WHEN ${current} THEN used_processing_seconds ELSE 0 END`;
            const changed = await client.query(`UPDATE users SET used_processing_seconds=(${used})+$1,
              used_ai_answers=CASE WHEN ${current} THEN used_ai_answers ELSE 0 END,
              usage_period_start=CASE WHEN ${current} THEN usage_period_start ELSE now() END
              WHERE id=$2 AND is_over_quota IS NOT TRUE AND (${used})<=9007199254740991-$1
              AND (processing_limit_minutes IS NULL OR (${used})<=processing_limit_minutes::bigint*60-$1) RETURNING id`, [seconds, video.user_id]);
            allowed = Boolean(changed.rowCount);
            if (allowed) await client.query("UPDATE videos SET processing_seconds=$1 WHERE id=$2", [seconds, videoId]);
          }
          const user = (await client.query<{ processing_limit_minutes: number | null }>(
            "SELECT processing_limit_minutes FROM users WHERE id=$1", [video.user_id])).rows[0];
          if (!user) throw new Error("Processing owner not found");
          await client.query("COMMIT");
          return { allowed, limitSeconds: user.processing_limit_minutes === null ? null : user.processing_limit_minutes * 60 };
        } catch (error) { await client.query("ROLLBACK"); throw error; }
      });
    },
  };
}
