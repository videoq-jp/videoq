import type { Bindings } from "../types/bindings";
import { createIdempotencyRetentionRepository } from "../persistence/factory";

const MCP_IDEMPOTENCY_RETENTION_DAYS = 30;

export type { CreationIdempotency } from "../persistence/contracts/creation-idempotency";

/** 日次 maintenance で古い再試行台帳を小分けに削除する。 */
export async function pruneMcpIdempotencyRecords(
  env: Bindings,
  retentionDays = MCP_IDEMPOTENCY_RETENTION_DAYS,
  limit = 500,
): Promise<{ deleted: number }> {
  if (!Number.isSafeInteger(retentionDays) || retentionDays < 1) {
    throw new Error("retentionDays must be a positive integer.");
  }
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 5000) {
    throw new Error("limit must be an integer between 1 and 5000.");
  }
  return (await createIdempotencyRetentionRepository(env)).prune(retentionDays, limit);
}
