export interface IdempotencyRetentionRepository {
  /** Atomic bounded cleanup. Application validates positive days and a limit <= 5000. */
  prune(retentionDays: number, limit: number): Promise<{ deleted: number }>;
}
