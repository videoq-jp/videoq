export type CreationIdempotency = {
  action: 'request_video_upload' | 'create_youtube_video' | 'create_course';
  key: string;
  requestHash: string;
};

export type ExistingIdempotentResource<Id = number> =
  | { found: false }
  | { found: true; conflict: true }
  | { found: true; conflict: false; resourceId: Id };

export function creationReceiptResult<Id>(
  stored: { requestHash: string; resourceId: Id } | undefined, expectedHash: string,
): ExistingIdempotentResource<Id> {
  if (!stored) return { found: false };
  return stored.requestHash === expectedHash
    ? { found: true, conflict: false, resourceId: stored.resourceId }
    : { found: true, conflict: true };
}

export function validateCreationIdempotency(input: CreationIdempotency | undefined, action: CreationIdempotency['action']): void {
  if (input && (input.action !== action || !input.key || input.key.length > 128 || !/^[a-f0-9]{64}$/.test(input.requestHash))) {
    throw new Error('Invalid creation idempotency');
  }
}
