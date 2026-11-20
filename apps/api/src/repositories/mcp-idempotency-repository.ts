import type { Bindings } from "../types/bindings";
import { createIdempotencyRetentionRepository } from "../persistence/factory";
import { pruneIdempotencyRetention } from "../features/maintenance/idempotency-retention-service";

export type { CreationIdempotency } from "../persistence/contracts/creation-idempotency";

/** 日次 maintenance で古い再試行台帳を小分けに削除する。 */
export async function pruneMcpIdempotencyRecords(
  env: Bindings,
  retentionDays?: number,
  limit?: number,
): Promise<{ deleted: number }> {
  return pruneIdempotencyRetention(
    () => createIdempotencyRetentionRepository(env), retentionDays, limit,
  );
}
