import { createLmsUploadRepository } from '../persistence/factory';
import type { OwnedLmsGrant, LmsUploadSnapshot } from '../domain/lms/lms-upload';
import { createLmsUploadService } from '../features/lms/upload-service';
import { buildPendingUploadFileKey, fileExtension } from '../lib/upload';
import { deadlineSignal } from '../lib/request-timeout';
import { armMaintenance } from '../lib/task-scheduler';
import { processExternalTaskById } from '../lib/external-tasks';
import { getR2ObjectSize, putMediaObject } from './media';
import type { Bindings } from '../types/bindings';
import { lmsUploadStream } from '../features/lms/upload';
import { asLmsSyncError } from '../features/lms/resource';

async function service(env: Bindings) {
  const repository = await createLmsUploadRepository(env);
  return createLmsUploadService({
    newAttempt: (grant, snapshot) => ({ id: crypto.randomUUID(), grant, snapshot,
      fileKey: buildPendingUploadFileKey(grant.ownerUserId, snapshot.size, fileExtension(snapshot.fileKey)) }),
    prepare: attempt => repository.prepare(attempt),
    adopt: attempt => repository.adopt(attempt),
    abandon: attempt => repository.abandon(attempt),
    scheduleCleanup: delay => armMaintenance(env, Date.now() + delay),
    cleanupDeferred: () => { console.error(JSON.stringify({ event: 'lms_upload_cleanup_deferred' })); },
    objectSize: key => getR2ObjectSize(env, key),
    confirm: (...args) => repository.confirm(...args),
    deliver: async id => { await processExternalTaskById(env, id); },
  });
}
export async function uploadLmsContent(env: Bindings, grant: OwnedLmsGrant, snapshot: LmsUploadSnapshot, body: ReadableStream<Uint8Array>, callerSignal?: AbortSignal) {
  try {
    await (await service(env)).upload(grant, snapshot, attempt => {
      const signal = deadlineSignal(10 * 60000, callerSignal);
      return {
        write: async () => { await putMediaObject(env, attempt.fileKey, lmsUploadStream(body, snapshot.size, signal), snapshot.contentType); },
        expired: () => signal.aborted,
      };
    });
  } catch (error) { throw asLmsSyncError(error) ?? error; }
}
export async function confirmLmsUpload(env: Bindings, grant: OwnedLmsGrant, snapshot: LmsUploadSnapshot, status: string) {
  try { await (await service(env)).confirm(grant, snapshot, status); }
  catch (error) { throw asLmsSyncError(error) ?? error; }
}
