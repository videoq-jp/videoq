import { and, eq, sql, exists } from "drizzle-orm";
import { createD1Connection } from "../../db/d1/connection";
import { mcpIdempotencyRecords as records } from "../../db/schema/sqlite";
import type { IdempotencyRetentionRepository } from "../contracts/idempotency-retention-repository";
export function createD1IdempotencyRetentionRepository(
  database: D1Database,
): IdempotencyRetentionRepository {
  const db = createD1Connection(database);
  return {
    async prune(retentionDays, limit) {
      const victims = db.$with("victims").as(
        db
          .select({
            userId: records.userId,
            action: records.action,
            key: records.key,
          })
          .from(records)
          .where(
            sql`julianday(${records.createdAt})<julianday('now')-${retentionDays}`,
          )
          .orderBy(
            records.createdAt,
            records.userId,
            records.action,
            records.key,
          )
          .limit(limit),
      );
      const result = await db
        .with(victims)
        .delete(records)
        .where(
          exists(
            db
              .select({ key: victims.key })
              .from(victims)
              .where(
                and(
                  eq(victims.userId, records.userId),
                  eq(victims.action, records.action),
                  eq(victims.key, records.key),
                ),
              ),
          ),
        )
        .run();
      return { deleted: result.meta.changes };
    },
  };
}
