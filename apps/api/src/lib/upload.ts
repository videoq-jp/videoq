import { buildPendingUploadFileKey as serializeUploadFileKey } from "../domain/media/upload";
export { fileExtension, isAllowedExtension, isAllowedContentType, parseReservedBytesFromFileKey,
  unsupportedTypeMessage, invalidContentTypeMessage } from "../domain/media/upload";

/** Runtime adapter for callers that need a fresh upload identity. */
export function buildPendingUploadFileKey(
  userId: string, reservedBytes: number, ext: string,
  nowMs: number = Date.now(),
  nonce: string = crypto.randomUUID().replaceAll("-", "").slice(0, 12),
): string {
  return serializeUploadFileKey(userId, reservedBytes, ext, nowMs, nonce);
}
