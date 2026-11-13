import type { JobMessage } from "../../lib/job-message";

export type ExternalTaskKind =
  | "sqs_job"
  | "storage_cleanup"
  | "invitation_email"
  | "multipart_abort"
  | "multipart_cleanup";

export type ExternalTaskLease = {
  id: number;
  attempt: number;
};

export type ClaimedExternalTask = ExternalTaskLease & {
  kind: ExternalTaskKind;
  payload: Record<string, unknown>;
};

export type PersistedExternalTask = {
  id: number;
  created: boolean;
};

export class ExternalTaskLeaseLostError extends Error {
  constructor() {
    super("External task lease is no longer owned by this attempt.");
    this.name = "ExternalTaskLeaseLostError";
  }
}

export type ExternalTaskHealth = {
  pending: number;
  dead: number;
  oldestPendingSeconds: number | null;
};

export interface ExternalTaskRepository {
 createJob(params: {message: JobMessage;dedupeKey?: string}): Promise<PersistedExternalTask>;
 claim(params: {limit: number;taskId?: number;excludeTaskIds?: readonly number[]}): Promise<ClaimedExternalTask[]>;
 complete(lease: ExternalTaskLease): Promise<void>;
 defer(lease:ExternalTaskLease,delayMs:number):Promise<void>;
 completeStorageCleanup(params: {lease: ExternalTaskLease;userId: string;bytes: number|null}): Promise<void>;
 fail(lease: ExternalTaskLease,error: string): Promise<{dead: boolean;leaseLost: boolean}>;
 health(): Promise<ExternalTaskHealth>;
 pruneHistory(retentionDays?: number,limit?: number): Promise<{externalTasks: number;jobExecutions: number}>;
}
