import { textValueFailure } from './text-value';
export const TRANSCRIPTION_LANGUAGES = {
  ja: '日本語', en: 'English', zh: '中文', ko: '한국어',
  es: 'Español', fr: 'Français', de: 'Deutsch', pt: 'Português',
  it: 'Italiano', ru: 'Русский', hi: 'हिन्दी', ar: 'العربية',
} as const;
export type TranscriptionLanguage = keyof typeof TRANSCRIPTION_LANGUAGES;

/** Shared upload formats, ordered for validation messages. */
export const VIDEO_UPLOAD_TYPES = {
  '.3gp': 'video/3gpp',
  '.avi': 'video/x-msvideo',
  '.m4v': 'video/x-m4v',
  '.mkv': 'video/x-matroska',
  '.mov': 'video/quicktime',
  '.mp4': 'video/mp4',
  '.mpeg': 'video/mpeg',
  '.mpg': 'video/mpeg',
  '.webm': 'video/webm',
} as const;

const contentTypes = new Set<string>([
  ...Object.values(VIDEO_UPLOAD_TYPES),
  // Modern browsers use the registered type alongside the legacy video/x-matroska.
  'video/matroska',
]);

/** A leading dot alone is not an extension; directory names are ignored. */
export function fileExtension(filename: string): string {
  const base = filename.split(/[\\/]/).pop() ?? filename;
  let start = 0;
  while (start < base.length && base[start] === '.') start++;
  const dot = base.lastIndexOf('.');
  return dot < start ? '' : base.slice(dot).toLowerCase();
}

export function isAllowedExtension(ext: string): ext is keyof typeof VIDEO_UPLOAD_TYPES {
  return Object.hasOwn(VIDEO_UPLOAD_TYPES, ext);
}

export function isAllowedContentType(contentType: string): boolean {
  return contentTypes.has(contentType);
}

/** Infer only when the browser has no specific MIME type; explicit types stay validated. */
export function videoUploadContentType(file: { name: string; type: string }): string | null {
  const ext = fileExtension(file.name);
  if (!isAllowedExtension(ext)) return null;
  if (!file.type || file.type === 'application/octet-stream') return VIDEO_UPLOAD_TYPES[ext];
  return isAllowedContentType(file.type) ? file.type : null;
}

// R2 physical ceiling (not an account/plan cap): 5 TiB minus 5 GiB.
// https://developers.cloudflare.com/r2/platform/limits/
export const MULTIPART_UPLOAD_THRESHOLD = 100 * 1024 * 1024;
export const MAX_VIDEO_UPLOAD_BYTES = 5 * 1024 ** 4 - 5 * 1024 ** 3;
export const MAX_SINGLE_UPLOAD_BYTES = 5 * 1024 ** 3;
export const MAX_UPLOAD_PARTS = 10_000;

export function multipartPartSize(fileSize: number): number {
  const mib = 1024 * 1024;
  return Math.max(64 * mib, Math.ceil(fileSize / MAX_UPLOAD_PARTS / mib) * mib);
}

/** An HTTP opaque entity tag without its surrounding quotes. R2 Workers part
 * ETags need not be MD5 hashes. Bound size and reject quotes/control bytes. */
export function isValidUploadPartEtag(value:unknown):value is string {
  return typeof value==='string'&&/^[\x21\x23-\x7e]{1,1024}$/.test(value);
}

/** Public metadata uses 255 UTF-16 units, consistent with API and HTML limits. */
export const MAX_VIDEO_TITLE_LENGTH = 255;
export function videoTitleFailure(value: string): string | null {
  const textError = textValueFailure(value);
  if (textError) return textError;
  const title = value.trim();
  if (!title) return 'This field may not be blank.';
  return title.length > MAX_VIDEO_TITLE_LENGTH ? 'Ensure this field has no more than 255 characters.' : null;
}
export function uploadFilenameFailure(value: string): string | null {
  const textError = textValueFailure(value);
  if (textError) return textError;
  const filename = value.trim(), ext = fileExtension(filename);
  if (!filename || filename.length > 255) return 'Filename must contain 1 to 255 characters.';
  return isAllowedExtension(ext) ? null : `Unsupported file type: '${ext}'. Allowed types: ${Object.keys(VIDEO_UPLOAD_TYPES).join(', ')}`;
}
export function uploadContentTypeFailure(value: string): string | null {
  const contentType = value.trim();
  return contentType.length <= 100 && isAllowedContentType(contentType) ? null
    : `Invalid content type: '${contentType}'. Only video files are allowed.`;
}
export function uploadSizeFailure(bytes: number, singlePut = false): string | null {
  if (!Number.isSafeInteger(bytes) || bytes <= 0 || bytes > MAX_VIDEO_UPLOAD_BYTES) return 'Invalid file size (exceeds the storage provider object limit).';
  return singlePut && bytes > MAX_SINGLE_UPLOAD_BYTES ? 'Files larger than 5 GiB require multipart upload.' : null;
}
export function transcriptionLanguageFailure(value: string | undefined): string | null {
  return value === undefined || Object.hasOwn(TRANSCRIPTION_LANGUAGES, value) ? null : 'Invalid transcription language.';
}
