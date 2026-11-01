type UploadedPart = { partNumber: number; etag: string };

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
        const etag = xhr.getResponseHeader('ETag')?.replace(/^"|"$/g, '');
        if (!etag || !/^[a-fA-F0-9]{32}$/.test(etag)) {
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

async function retry<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    signal.throwIfAborted();
    try { return await operation(); }
    catch (error) {
      if (signal.aborted || attempt >= 6 || !canRetry(error)) throw error;
      await new Promise<void>((resolve, reject) => {
        const abort = () => { clearTimeout(timer); reject(signal.reason instanceof Error ? signal.reason : new DOMException('Aborted', 'AbortError')); };
        const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, Math.min(30000, 1000 * 2 ** attempt));
        signal.addEventListener('abort', abort, { once: true });
      });
    }
  }
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
  const { part_size: partSize, part_count: partCount } = session;
  const uploaded = new Float64Array(partCount);
  const parts: UploadedPart[] = new Array<UploadedPart>(partCount);
  let next = 0;
  let percent = 0;
  const progress = (index: number, bytes: number) => {
    uploaded[index] = bytes;
    // Retries must not make the visible progress jump backwards. Keep 100%
    // for successful server-side completion and the size check.
    const total = uploaded.reduce((sum, value) => sum + value, 0);
    percent = Math.max(percent, Math.min(99, Math.floor(total / file.size * 100)));
    onProgress?.(percent);
  };
  const worker = async () => {
    try {
      while (next < partCount) {
        signal.throwIfAborted();
        const index = next++;
        // Blob.slice doesn't load the entire video into JavaScript memory.
        const body = file.slice(index * partSize, Math.min((index + 1) * partSize, file.size), contentType);
        const etag = await retry(async () => {
          progress(index, 0);
          // Mint just before each transfer/retry so long uploads do not depend
          // on URLs issued hours earlier. This also refreshes the server lease.
          const { upload_url } = await operations.partUrl(index + 1);
          signal.throwIfAborted();
          return uploadPart(upload_url, body, contentType, signal, bytes => progress(index, bytes));
        }, signal);
        parts[index] = { partNumber: index + 1, etag };
        progress(index, body.size);
      }
    } catch (error) {
      controller.abort(error);
      throw error;
    }
  };
  try {
    const results = await Promise.allSettled(Array.from({ length: Math.min(3, partCount) }, worker));
    const failed = results.find(result => result.status === 'rejected');
    if (failed?.status === 'rejected') throw failed.reason;
    const result = await retry(() => operations.complete(parts), signal);
    onProgress?.(100);
    return result;
  } catch (error) {
    controller.abort(error);
    // All PUTs have settled before aborting the storage session. The API only
    // deletes an unconfirmed upload, including if a completion response was lost.
    try { await operations.abort(); }
    catch { /* Server abandonment reconciliation retries durable cleanup. */ }
    throw error;
  }
}
