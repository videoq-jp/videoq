import { lt, sql } from 'drizzle-orm';
import { withDb } from '../../db/pool';
import { mcpIdempotencyRecords } from '../../db/schema';
import type { Bindings } from '../../types/bindings';
import type { IdempotencyRetentionRepository } from '../contracts/idempotency-retention-repository';
export function createPostgresIdempotencyRetentionRepository(env: Bindings): IdempotencyRetentionRepository {
  return {
    prune: (retentionDays, limit) => withDb(env, async db => {
      const victims = db.select({ userId: mcpIdempotencyRecords.userId, action: mcpIdempotencyRecords.action, key: mcpIdempotencyRecords.key })
        .from(mcpIdempotencyRecords).where(lt(mcpIdempotencyRecords.createdAt,sql`now() - (${retentionDays} * INTERVAL '1 day')`))
        .orderBy(mcpIdempotencyRecords.createdAt,mcpIdempotencyRecords.userId,mcpIdempotencyRecords.action,mcpIdempotencyRecords.key).limit(limit).as('victims');
      const rows = await db.delete(mcpIdempotencyRecords).where(sql`(${mcpIdempotencyRecords.userId}, ${mcpIdempotencyRecords.action}, ${mcpIdempotencyRecords.key}) IN (SELECT ${victims.userId}, ${victims.action}, ${victims.key} FROM ${victims})`)
        .returning({ key:mcpIdempotencyRecords.key });
      return { deleted:rows.length };
    }),
  };
}
