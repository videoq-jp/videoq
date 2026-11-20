import { parseReservedBytesFromFileKey } from './upload';

export type VideoPatch = { title?: string; description?: string; transcript?: string };
export type VideoDeletionOptions = {
  expectedStatus?: string;
  expectedFileKey?: string;
  fallbackStorageBytes?: number | null;
  inactiveBefore?: Date;
};

export function validateVideoDeletionOptions(options: VideoDeletionOptions): void {
  if (options.fallbackStorageBytes != null && (!Number.isSafeInteger(options.fallbackStorageBytes) || options.fallbackStorageBytes < 0) ||
    options.inactiveBefore && !Number.isFinite(options.inactiveBefore.getTime())) throw new Error('Invalid video deletion options');
}

/** Change comparisons are evaluated under the adapter's write fence. */
export function planVideoPatch(fields: VideoPatch, changes: { title: boolean; description: boolean; transcript: boolean }) {
  const patch: VideoPatch = {};
  if (changes.title) patch.title = fields.title;
  if (changes.description) patch.description = fields.description;
  if (changes.transcript) patch.transcript = fields.transcript;
  return { patch, syncTitle: changes.title, reindex: changes.transcript };
}

export function videoTranscriptChanged<Predicate>(provided: Predicate, different: Predicate,
  logic: { and(left: Predicate, right: Predicate): Predicate }): Predicate {
  return logic.and(provided, different);
}

export function videoDeletionAllowed(video: { status: string; file: string; heartbeat: string | null } | undefined,
  options: VideoDeletionOptions): boolean {
  if (!video) return false;
  // Keep the existing comparison for malformed stored dates: NaN does not
  // become a fresh heartbeat. Expiry equality still refuses abandonment.
  return !(options.expectedStatus !== undefined && video.status !== options.expectedStatus ||
    options.expectedFileKey !== undefined && video.file !== options.expectedFileKey ||
    options.inactiveBefore !== undefined && video.heartbeat !== null && new Date(video.heartbeat) >= options.inactiveBefore);
}

export function videoCleanup(file: string, fallbackBytes?: number | null) {
  const fileKey = file || null;
  return { fileKey, bytes: fileKey ? parseReservedBytesFromFileKey(fileKey) ?? fallbackBytes ?? null : null };
}

export interface UploadRefundLogic<Value, Predicate> {
  statusIs(status: Value, expected: 'uploading'): Predicate;
  positive(bytes: Value): Predicate;
  and(left: Predicate, right: Predicate): Predicate;
}

/** A confirmed upload consumes its month's allowance even after deletion. */
export function videoAbortRefundAllowed<Value, Predicate>(status: Value, bytes: Value,
  logic: UploadRefundLogic<Value, Predicate>): Predicate {
  return logic.and(logic.statusIs(status, 'uploading'), logic.positive(bytes));
}

export const videoRefundBooleanLogic: UploadRefundLogic<string | number | null, boolean> = {
  statusIs: (status, expected) => status === expected,
  positive: bytes => typeof bytes === 'number' && bytes > 0,
  and: (left, right) => left && right,
};
