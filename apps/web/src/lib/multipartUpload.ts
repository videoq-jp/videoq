import {isValidUploadPartEtag} from '@videoq/domain/video-upload';
import { executeMultipartUpload, type UploadedPart } from '../application/multipart-upload';

class PartUploadError extends Error {
  readonly retryable: boolean;
  constructor(message: string, retryable: boolean) { super(message); this.retryable = retryable; }
}

export function uploadPart(
  url: string, body: Blob, contentType: string, signal: AbortSignal,
  onProgress: (bytes: number) => void,
): Promise<string> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason instanceof Error ? signal.reason : new DOMException('Aborted', 'AbortError')); return; }
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    xhr.setRequestHeader('Content-Type', contentType);
    xhr.timeout = 15 * 60 * 1000;
    const abort = () => xhr.abort();
    const cleanup = () => signal.removeEventListener('abort', abort);
    signal.addEventListener('abort', abort, { once: true });
    xhr.upload.addEventListener('progress', event => onProgress(Math.min(event.loaded, body.size)));
    xhr.addEventListener('load', () => {
      cleanup();
      if (xhr.status >= 200 && xhr.status < 300) {
        const raw = xhr.getResponseHeader('ETag');
        const etag = raw?.startsWith('"') && raw.endsWith('"') ? raw.slice(1, -1) : raw;
        if (!etag || !isValidUploadPartEtag(etag)) {
          reject(new PartUploadError('Upload response is missing ETag. Check storage CORS settings.', false));
        } else resolve(etag);
      } else {
        const code = xhr.responseText?.match(/<Code>([A-Za-z0-9]+)<\/Code>/)?.[1];
        reject(new PartUploadError(`Upload failed with status ${xhr.status}${code ? ` (${code})` : ''}`,
          xhr.status === 0 || xhr.status === 403 || xhr.status === 408 || xhr.status === 429 || xhr.status >= 500));
      }
    });
    xhr.addEventListener('error', () => { cleanup(); reject(new PartUploadError('Upload failed', true)); });
    xhr.addEventListener('timeout', () => { cleanup(); reject(new PartUploadError('Upload timed out', true)); });
    xhr.addEventListener('abort', () => { cleanup(); reject(signal.reason instanceof Error ? signal.reason : new DOMException('Aborted', 'AbortError')); });
    xhr.send(body);
  });
}

function canRetry(error: unknown): boolean {
  if (error instanceof PartUploadError) return error.retryable;
  // tRPC errors carry an HTTP status; network failures have no status.
  const status = (error as { data?: { httpStatus?: number } } | null)?.data?.httpStatus;
  return status === undefined || status === 408 || status === 429 || status >= 500;
}

function wait(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(signal.reason instanceof Error ? signal.reason : new DOMException('Aborted', 'AbortError')); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, milliseconds);
    signal.addEventListener('abort', abort, { once: true });
  });
}

export async function uploadMultipartFile<T>(
  file: File, contentType: string, session: { part_size: number; part_count: number },
  operations: {
    partUrl: (partNumber: number) => Promise<{ upload_url: string }>;
    complete: (parts: UploadedPart[]) => Promise<T>;
    abort: () => Promise<unknown>;
  },
  onProgress?: (percent: number) => void,
): Promise<T> {
  const controller = new AbortController();
  const { signal } = controller;
  return executeMultipartUpload({
    size: file.size, partSize: session.part_size, partCount: session.part_count,
    slice: (start, end) => file.slice(start, end, contentType),
    bodySize: body => body.size,
    partUrl: async number => (await operations.partUrl(number)).upload_url,
    upload: (url, body, progress) => uploadPart(url, body, contentType, signal, progress),
    complete: operations.complete, abortSession: operations.abort,
    throwIfCancelled: () => signal.throwIfAborted(),
    cancelled: () => signal.aborted, cancel: reason => controller.abort(reason),
    retryable: canRetry, wait: milliseconds => wait(milliseconds, signal),
  }, onProgress);
}
