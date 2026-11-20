/** Immutable object identity and the lease needed to finish/retry cleanup. */
export type VisualCleanup = {
  id: string; kind: 'chunk' | 'manifest'; file_key: string; run_id: string;
  chunk_index: number | null; object_version: string; lease_token: string;
};
export interface VisualObjectCleanupRepository {
  claim(): Promise<VisualCleanup | null>;
  complete(task: VisualCleanup): Promise<boolean>;
  retry(task: VisualCleanup): Promise<void>;
}
