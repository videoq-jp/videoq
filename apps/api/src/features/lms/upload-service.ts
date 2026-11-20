import type { OwnedLmsGrant, LmsUploadSnapshot, LmsContentAttempt, LmsUploadSource } from '../../application/lms-upload';
import { ApplicationError } from '../../application/errors';

const failure = (code: string) => new ApplicationError('conflict', code, code);
/** Check generation before the transport examines content headers or body. */
export function validateLmsUploadResource<T extends LmsUploadSource & { ownerUserId: string }>(
  data: T | null, generation: number, operation: 'content' | 'confirm',
): asserts data is T & { video: NonNullable<T['video']> } {
  if (!data?.video || data.resource.kind !== 'video' || !data.resource.enabled
    || data.resource.generation !== generation || (operation === 'confirm' && !data.ownerUserId)) {
    throw failure('STALE_GENERATION');
  }
}

export function createLmsUploadSnapshot(data: LmsUploadSource | null, externalId: string, generation: number): LmsUploadSnapshot {
  if (!data?.video || data.resource.kind !== 'video' || !data.resource.enabled || data.resource.generation !== generation || data.resource.fileSize === null || !data.resource.contentType) {
    throw failure('STALE_GENERATION');
  }
  return { resourceId: data.resource.id, externalId, generation, videoId: data.video.id,
    fileKey: data.video.file, size: data.resource.fileSize, contentType: data.resource.contentType };
}

export interface LmsUploadExecution {
  write(): Promise<void>;
  expired(): boolean;
}
export interface LmsUploadDependencies {
  newAttempt(grant: OwnedLmsGrant, snapshot: LmsUploadSnapshot): LmsContentAttempt;
  prepare(attempt: LmsContentAttempt): Promise<boolean>;
  adopt(attempt: LmsContentAttempt): Promise<boolean>;
  abandon(attempt: LmsContentAttempt): Promise<void>;
  scheduleCleanup(delayMs: number): Promise<void>;
  cleanupDeferred(): void;
  objectSize(fileKey: string): Promise<number | null>;
  confirm(grant: OwnedLmsGrant, snapshot: LmsUploadSnapshot, objectVerified: boolean): Promise<
    { status: 'stale' } | { status: 'already' } | { status: 'queued'; job: { taskId: number } }
  >;
  deliver(taskId: number): Promise<void>;
}

/** Persist claims and adoption atomically; storage I/O runs between those operations. */
export function createLmsUploadService(deps: LmsUploadDependencies) {
  return {
    async upload(grant: OwnedLmsGrant, snapshot: LmsUploadSnapshot, execution: (attempt: LmsContentAttempt) => LmsUploadExecution) {
      const attempt = deps.newAttempt(grant, snapshot);
      if (!await deps.prepare(attempt)) throw failure('UPLOAD_UNAVAILABLE');
      await deps.scheduleCleanup(2 * 3600000);
      const transfer = execution(attempt);
      try {
        await transfer.write();
        if (transfer.expired()) throw failure('UPLOAD_EXPIRED');
        if (!await deps.adopt(attempt)) throw failure('STALE_GENERATION');
      } catch (error) {
        try { await deps.abandon(attempt); } catch { deps.cleanupDeferred(); }
        await deps.scheduleCleanup(0);
        if (transfer.expired()) throw failure('UPLOAD_EXPIRED');
        throw error;
      }
    },
    async confirm(grant: OwnedLmsGrant, snapshot: LmsUploadSnapshot, status: string) {
      if (status === 'uploading' && await deps.objectSize(snapshot.fileKey) !== snapshot.size) {
        throw failure('UPLOAD_NOT_CONFIRMED');
      }
      const result = await deps.confirm(grant, snapshot, status === 'uploading');
      if (result.status === 'stale') throw failure('STALE_GENERATION');
      if (result.status === 'queued') await deps.deliver(result.job.taskId);
    },
  };
}
