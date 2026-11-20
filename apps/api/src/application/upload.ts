/**
 * 動画アップロード要求の定数と入力検証。
 */

import { VIDEO_UPLOAD_TYPES } from "@videoq/domain/video-upload";
export { fileExtension, isAllowedExtension, isAllowedContentType } from "@videoq/domain/video-upload";

/**
 * 署名 URL 発行時の file key。
 * `videos/{userId}/video_{ms}_{nonce}_{reservedBytes}{ext}` — 予約バイト数を埋め込み、
 * アップロード放棄時（FR-Q3）に R2 未着でも解放できるようにする。
 * nonce は同一ミリ秒・同一サイズの並行要求によるオブジェクトキー衝突を防ぐ。
 */
export function buildPendingUploadFileKey(
  userId: string,
  reservedBytes: number,
  ext: string,
  nowMs: number,
  nonce: string,
): string {
  return `videos/${userId}/video_${nowMs}_${nonce}_${reservedBytes}${ext}`;
}

/**
 * file key から予約バイト数を読む（新形式のみ）。
 * 旧形式 `video_{ms}{ext}` は null。
 */
export function parseReservedBytesFromFileKey(fileKey: string): number | null {
  const base = fileKey.split(/[\\/]/).pop() ?? fileKey;
  // video_{timestamp}_{nonce}_{bytes}.ext（nonce 無しの従来形式も受理）
  const m = /^video_\d+_(?:[0-9a-f]{12}_)?(\d+)\.[^.]+$/i.exec(base);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

export function unsupportedTypeMessage(ext: string): string {
  return `Unsupported file type: '${ext}'. Allowed types: ${Object.keys(VIDEO_UPLOAD_TYPES).join(", ")}`;
}

export function invalidContentTypeMessage(contentType: string): string {
  return `Invalid content type: '${contentType}'. Only video files are allowed.`;
}
