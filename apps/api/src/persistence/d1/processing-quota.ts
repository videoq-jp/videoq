import { validateProcessingReservation, type ProcessingQuotaRepository } from "../contracts/processing-quota";
const CURRENT = "strftime('%Y-%m',u.usage_period_start)=strftime('%Y-%m','now')";
const USED = `CASE WHEN ${CURRENT} THEN u.used_processing_seconds ELSE 0 END`;
export function createD1ProcessingQuotaRepository(database: D1Database): ProcessingQuotaRepository {
  return {
    async reserve(videoId, seconds) {
      validateProcessingReservation(videoId, seconds);
      const token = crypto.randomUUID();
      const result = await database.batch<{ kind: string; processing_limit_minutes: number | null }>([
        database.prepare(`INSERT INTO mutation_receipts(token,kind,resource_id)
          SELECT ?,CASE WHEN v.processing_seconds>0 THEN 'processing_reused' ELSE 'processing_reserved' END,v.id
          FROM videos v JOIN users u ON u.id=v.user_id WHERE v.id=? AND
          (v.processing_seconds>0 OR (u.is_over_quota IS NOT TRUE AND (${USED})<=9007199254740991-?
            AND (u.processing_limit_minutes IS NULL OR (${USED})<=u.processing_limit_minutes*60-?)))`)
          .bind(token, videoId, seconds, seconds),
        database.prepare(`UPDATE users AS u SET used_processing_seconds=(${USED})+?,
          used_ai_answers=CASE WHEN ${CURRENT} THEN used_ai_answers ELSE 0 END,
          usage_period_start=CASE WHEN ${CURRENT} THEN usage_period_start ELSE strftime('%Y-%m-%dT%H:%M:%fZ','now','start of month') END
          WHERE id=(SELECT user_id FROM videos WHERE id=?)
            AND EXISTS(SELECT 1 FROM mutation_receipts WHERE token=? AND kind='processing_reserved')`)
          .bind(seconds, videoId, token),
        database.prepare(`UPDATE videos SET processing_seconds=? WHERE id=?
          AND EXISTS(SELECT 1 FROM mutation_receipts WHERE token=? AND kind='processing_reserved')`).bind(seconds, videoId, token),
        database.prepare(`SELECT r.kind,u.processing_limit_minutes FROM videos v JOIN users u ON u.id=v.user_id
          LEFT JOIN mutation_receipts r ON r.token=? WHERE v.id=?`).bind(token, videoId),
        database.prepare("DELETE FROM mutation_receipts WHERE token=?").bind(token),
      ]);
      const row = result[3].results[0];
      if (!row) throw new Error("Processing video not found");
      return { allowed: Boolean(row.kind), limitSeconds: row.processing_limit_minutes === null ? null : row.processing_limit_minutes * 60 };
    },
  };
}
