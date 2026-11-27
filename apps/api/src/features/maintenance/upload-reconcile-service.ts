import { parseReservedBytesFromFileKey } from '../../domain/media/upload';

const DEFAULT_ABANDON_HOURS = 2;
export const ABANDONED_UPLOAD_MS = DEFAULT_ABANDON_HOURS * 60 * 60 * 1000;
export type ReconcileResult = { scanned: number; released: number; releasedBytes: number; errors: number };
export interface UploadReconcileDependencies {
  listStale(hours: number): Promise<Array<{ id: number; userId: string; fileKey: string | null }>>;
  objectSize(key: string): Promise<number | null>;
  deleteVideo(id: number, userId: string, options: {
    expectedStatus: 'uploading'; fallbackStorageBytes: number | null; inactiveBefore: Date;
  }): Promise<{ deleted: boolean; cleanupTaskId: number | null }>;
  processTask(taskId: number): Promise<boolean>;
  now(): number;
}

export async function resolveStorageBytesForRelease(deps: Pick<UploadReconcileDependencies, 'objectSize'>, fileKey: string | null): Promise<number | null> {
  if (!fileKey) return null;
  const reservedBytes = parseReservedBytesFromFileKey(fileKey);
  if (reservedBytes !== null) return reservedBytes;
  try {
    const size = await deps.objectSize(fileKey);
    return size !== null && size > 0 ? size : null;
  } catch { return null; }
}

export async function reconcileAbandonedUploads(deps: UploadReconcileDependencies, olderThanHours = DEFAULT_ABANDON_HOURS): Promise<ReconcileResult> {
  const stale = await deps.listStale(olderThanHours);
  const result: ReconcileResult = { scanned: stale.length, released: 0, releasedBytes: 0, errors: 0 };
  for (const row of stale) {
    try {
      const bytes = await resolveStorageBytesForRelease(deps, row.fileKey);
      const deleted = await deps.deleteVideo(row.id, row.userId, {
        expectedStatus: 'uploading', fallbackStorageBytes: bytes,
        inactiveBefore: new Date(deps.now() - olderThanHours * 60 * 60 * 1000),
      });
      if (!deleted.deleted) continue;
      const completed = deleted.cleanupTaskId === null || await deps.processTask(deleted.cleanupTaskId);
      if (completed && bytes !== null && bytes > 0) result.releasedBytes += bytes;
      result.released += 1;
    } catch { result.errors += 1; }
  }
  return result;
}
