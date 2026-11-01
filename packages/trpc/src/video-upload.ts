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
