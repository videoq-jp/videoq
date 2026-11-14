import type { IdempotencyRetentionRepository } from '../contracts/idempotency-retention-repository';
export function createD1IdempotencyRetentionRepository(database: D1Database): IdempotencyRetentionRepository {
  return {
    async prune(retentionDays, limit) {
      const result = await database.prepare(`DELETE FROM mcp_idempotency_records
        WHERE (user_id,action,key) IN (
          SELECT user_id,action,key FROM mcp_idempotency_records
          WHERE julianday(created_at)<julianday('now')-?
          ORDER BY created_at,user_id,action,key LIMIT ?
        )`).bind(retentionDays, limit).run();
      return { deleted: result.meta.changes };
    },
  };
}
