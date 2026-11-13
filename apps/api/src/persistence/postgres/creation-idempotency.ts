export type {CreationIdempotency} from '../contracts/creation-idempotency';
import type {CreationIdempotency} from '../contracts/creation-idempotency';
import {and,eq,sql} from 'drizzle-orm';
import type {Db} from '../../db/pool';
import {mcpIdempotencyRecords} from '../../db/schema';

export type ExistingIdempotentResource =
  | { found: false }
  | { found: true; conflict: true }
  | { found: true; conflict: false; resourceId: number };

/** 呼び出し側が user 行を FOR UPDATE 済みの transaction 内で使う。 */
export async function findIdempotentResource(
  db: Pick<Db, "select">,
  userId: string,
  idempotency: CreationIdempotency | undefined,
): Promise<ExistingIdempotentResource> {
  if (!idempotency) return { found: false };
  const rows = await db
    .select({
      requestHash: mcpIdempotencyRecords.requestHash,
      resourceId: mcpIdempotencyRecords.resourceId,
    })
    .from(mcpIdempotencyRecords)
    .where(
      and(
        eq(mcpIdempotencyRecords.userId, userId),
        eq(mcpIdempotencyRecords.action, idempotency.action),
        eq(mcpIdempotencyRecords.key, idempotency.key),
      ),
    )
    .limit(1);
  const row = rows[0];
  if (!row) return { found: false };
  if (row.requestHash !== idempotency.requestHash) {
    return { found: true, conflict: true };
  }
  return { found: true, conflict: false, resourceId: Number(row.resourceId) };
}

/** 対象リソースの INSERT と同じ transaction 内で記録する。 */
export async function recordIdempotentResource(
  db: Pick<Db, "insert">,
  userId: string,
  idempotency: CreationIdempotency | undefined,
  resourceId: number,
): Promise<void> {
  if (!idempotency) return;
  await db.insert(mcpIdempotencyRecords).values({
    userId,
    action: idempotency.action,
    key: idempotency.key,
    requestHash: idempotency.requestHash,
    resourceId,
    createdAt: sql`CURRENT_TIMESTAMP`,
  });
}
