import type { IdempotencyRetentionRepository } from '../../persistence/contracts/idempotency-retention-repository';
import { retentionBounds } from '../../domain/operations/retention-policy';

/** Validate policy before acquiring storage; cleanup itself remains atomic. */
export async function pruneIdempotencyRetention(
  repository: () => Promise<IdempotencyRetentionRepository>,
  retentionDays?: number,
  limit?: number,
): Promise<{ deleted: number }> {
  const bounds = retentionBounds(retentionDays, limit);
  return (await repository()).prune(bounds.retentionDays, bounds.limit);
}
