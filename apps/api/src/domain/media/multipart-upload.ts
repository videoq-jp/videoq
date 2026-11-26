import { MAX_UPLOAD_PARTS, isValidUploadPartEtag } from '@videoq/domain/video-upload';

export class UploadSessionError extends Error {
  constructor(message: string, readonly code: 'BAD_REQUEST' | 'NOT_FOUND' = 'BAD_REQUEST') {
    super(message);
  }
}

export type MultipartParts = { partNumber: number; etag: string }[];

export function uploadConfirmed(status: string): boolean {
  return ['pending', 'processing', 'indexing', 'completed', 'error'].includes(status);
}

export function assertMultipartInitialization(status: string): void {
  if (status !== 'uploading') throw new UploadSessionError('Upload is already confirmed');
}

/** Session decoding belongs to the adapter; admission precedes that decoding. */
export function activeMultipartSession<Session>(status: string, session: Session | null): Session {
  if (status !== 'uploading' || !session) throw new UploadSessionError('Multipart upload is not active');
  return session;
}

export function multipartReservation(size: number | null): number {
  if (!size) throw new UploadSessionError('Upload reservation is missing');
  return size;
}

export function multipartPartLength(size: number | null, partSize: number, partNumber: number): number {
  if (!size || !Number.isInteger(partNumber) || partNumber < 1 || partNumber > Math.ceil(size / partSize))
    throw new UploadSessionError('Invalid upload part number');
  return Math.min(partSize, size - (partNumber - 1) * partSize);
}

export function orderedMultipartParts(size: number | null, partSize: number, parts: MultipartParts): MultipartParts {
  const ordered = [...parts].sort((a, b) => a.partNumber - b.partNumber);
  if (!size || parts.length > MAX_UPLOAD_PARTS || parts.length !== Math.ceil(size / partSize)
    || ordered.some((part, index) => part.partNumber !== index + 1 || !isValidUploadPartEtag(part.etag)))
    throw new UploadSessionError('Upload parts are missing or invalid');
  return ordered;
}

export function multipartObjectMatches(actual: number | null, reserved: number): boolean {
  return actual === reserved;
}

export function assertMultipartObjectSize(actual: number | null, reserved: number): void {
  if (!multipartObjectMatches(actual, reserved)) throw new UploadSessionError('Uploaded object size does not match the reserved size');
}
