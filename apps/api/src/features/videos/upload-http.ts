import { videoUploadService } from '../../integrations/video-upload';
import type { Bindings } from '../../types/bindings';
import { directUploadTitleFailure, type DirectUploadResult } from './upload-service';

export function multipartUnavailableBody() {
  return { error: { code: 'VALIDATION_ERROR', message: 'Direct multipart upload is unavailable in object-storage mode. Call the videos.requestUpload tRPC procedure, PUT the file to upload_url, then call videos.confirmUpload.' } } as const;
}

/** Parse the raw HTTP form and map application failures to the existing wire contract. */
export async function createVideoFromMultipart(env: Bindings, userId: string, form: Record<string, string | File>) {
  const invalid = (field: string, message: string) => ({ ok: false as const, status: 400 as const,
    body: { error: { code: 'VALIDATION_ERROR', message, details: { [field]: [message] } } } });
  if (!(form.file instanceof File)) return invalid('file', 'No file was submitted.');
  if (typeof form.title !== 'string') return invalid('title', form.title === undefined ? 'This field is required.' : 'Not a valid string.');
  // Preserve the legacy form error for a nonempty whitespace-only title.
  if (form.title && !form.title.trim()) return invalid('title', 'Not a valid string.');
  const titleFailure = directUploadTitleFailure(form.title);
  if (titleFailure) return directUploadHttpResult(titleFailure);
  if (form.transcriptionLanguage !== undefined && typeof form.transcriptionLanguage !== 'string') return invalid('transcriptionLanguage', 'Invalid transcription language.');
  const result = await videoUploadService(env).createDirectUpload(userId, {
    file: form.file, title: form.title, description: typeof form.description === 'string' ? form.description : '',
    transcriptionLanguage: form.transcriptionLanguage,
  });
  return directUploadHttpResult(result);
}

export function directUploadHttpResult(result: DirectUploadResult) {
  if (result.ok) return result;
  const { kind, ...error } = result.error;
  return { ok: false as const, status: kind === 'storage' || kind === 'finalization' ? 500 as const : 400 as const,
    body: kind === 'unavailable' ? multipartUnavailableBody() : { error } };
}
