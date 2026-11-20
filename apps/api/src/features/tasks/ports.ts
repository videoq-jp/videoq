import type { ClaimedExternalTask, ExternalTaskLease } from '../../persistence/contracts/external-task-repository';

export interface ExternalTaskDependencies {
  claim(options: { limit: number; taskId?: number; excludeTaskIds: number[] }): Promise<ClaimedExternalTask[]>;
  complete(task: ExternalTaskLease): Promise<void>;
  completeStorage(options: { lease: ExternalTaskLease; userId: string; bytes: number | null }): Promise<void>;
  fail(task: ExternalTaskLease, message: string): Promise<{ dead: boolean; leaseLost: boolean }>;
  defer(task: ExternalTaskLease, milliseconds: number): Promise<void>;
  arm(at: number): Promise<unknown>;
  now(): number;
  safetyNetMs: number;
  emailDelivery: boolean;
  deleteBilling(userId: string): Promise<unknown>;
  sendJob(message: string): Promise<string | null>;
  hasUploadingFile(key: string): Promise<boolean>;
  referencesFile(key: string, uploadId?: string): Promise<boolean>;
  abortMultipart(key: string, uploadId: string): Promise<unknown>;
  deleteObject(key: string): Promise<unknown>;
  deleteVisualChunks(key: string): Promise<unknown>;
  frameKey(key: string): string;
  focusKey(key: string): string;
  deliverInvitation(id: number, task: ExternalTaskLease): Promise<{ delivered: true } | { skipped: true; reason: string }>;
  diagnostic(event: { event: string; taskId: number; attempt?: number; kind?: string; error?: string }): void;
}
