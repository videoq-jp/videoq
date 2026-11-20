export interface MaintenanceDependencies {
  readonly paused: boolean;
  recoverTasks(): Promise<unknown>;
  maintainScenes(): Promise<unknown>;
  maintainVisuals(): Promise<unknown>;
  sweepMaterials(): Promise<unknown>;
  reconcileUploads(): Promise<unknown>;
  failInvitations(now: Date, graceMs: number): Promise<unknown>;
  health(): Promise<{ pending: number; dead: number; oldestPendingSeconds: number | null }>;
  pruneHistory(): Promise<unknown>;
  pruneIdempotency(): Promise<unknown>;
  pruneConversations(): Promise<unknown>;
  pruneCredentials(): Promise<unknown>;
  pruneAudit(now: Date): Promise<unknown>;
  refresh(progressed: boolean): Promise<unknown>;
  report(event: string, results: Record<string, unknown>, failed: boolean): void;
}
